"""Scheduled operations (fiesta.ops) and the worker queue split; no infra."""

import asyncio
import contextlib
import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from fiesta.jobs.queues import OPS_QUEUE, main_worker_queues
from fiesta.ops import app as ops_app
from fiesta.ops.config import (
    OpsConfig,
    Schedule,
    load_ops_config,
    parse_duration,
    parse_ops_config,
)
from fiesta.ops.history import ScheduleState
from fiesta.ops.runner import (
    SUMMARY_ENV,
    build_env,
    parse_env_file,
    run_callable,
    run_command,
    summary_from_output,
)
from fiesta.ops.slack import (
    SlackNotifier,
    format_duration,
    format_failure,
    format_missed,
    format_success,
    format_summary,
    format_tail,
)
from fiesta.ops.watchdog import deadline_for, find_overdue, should_alert

CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"


def schedule(**overrides) -> Schedule:
    values = {
        "name": "job",
        "cron": "0 10 * * *",
        "command": ["true"],
        "expected_interval": "26h",
        "timeout": "1h",
    }
    values.update(overrides)
    return Schedule.model_validate(values)


# --- config -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "seconds"),
    [
        (90, 90),
        ("45s", 45),
        ("30m", 1800),
        ("2h", 7200),
        ("26h", 93600),
        ("1d2h", 93600),
        ("1h30m", 5400),
        ("15", 15),
        (0.5, 0.5),
    ],
)
def test_parse_duration(value, seconds):
    assert parse_duration(value) == seconds


@pytest.mark.parametrize("value", ["", "2x", "h", "-5", 0, "1h junk", True, None])
def test_parse_duration_rejects(value):
    with pytest.raises(ValueError):
        parse_duration(value)


def test_shipped_schedules_file_loads():
    config = load_ops_config(CONFIG_DIR / "ops" / "schedules.yaml")
    s = config.schedule("osu-mgr-incremental")
    assert s.cron == "0 10 * * *"
    assert s.command == [
        ".venv/bin/python",
        "osu_mgr_pipeline.py",
        "--incremental",
        "--since",
        "72h",
    ]
    assert s.cwd == "/srv/osu-mgr-pipeline"
    assert (s.timeout, s.expected_interval, s.notify) == (7200, 26 * 3600, "both")
    assert s.node == "osu-mgr"
    assert s.lock_key == "ops:osu-mgr-incremental"
    # every schedule names a node the deployment serves
    from fiesta.nodeconfig import load_deployment

    slugs = {n.node.slug for n in load_deployment(CONFIG_DIR / "fiesta.yaml").node_list}
    assert config.unknown_nodes(slugs) == []


def test_config_defaults_and_callable():
    config = parse_ops_config(
        """
fiesta-ops: 1
schedules:
  - name: refs
    cron: "0 3 * * 1"
    callable: fiesta.services.references:refresh_all
    expected_interval: 8d
    notify: failure
    lock: shared-lock
"""
    )
    assert config.slack.channel == ""
    assert config.watchdog.tick == 900
    s = config.schedule("refs")
    assert s.callable == "fiesta.services.references:refresh_all"
    assert s.lock_key == "shared-lock"
    assert s.label == "refs"
    with pytest.raises(KeyError):
        config.schedule("nope")


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"callable": "a.b"}, "exactly one"),
        ({"command": None}, "exactly one"),
        ({"command": []}, "non-empty"),
        ({"cron": "61 * * * *"}, "invalid cron"),
        ({"expected_interval": "24h"}, "must exceed"),
        ({"name": "Bad Name"}, "lowercase"),
        ({"kwargs": {"a": 1}}, "apply to `callable` only"),
        ({"notify": "sometimes"}, "notify"),
        ({"unknown_key": 1}, "unknown_key"),
        ({"command": None, "callable": "nomodule"}, "module"),
        ({"command": None, "callable": "a.b", "cwd": "/tmp"}, "command` only"),
    ],
)
def test_schedule_validation(overrides, message):
    with pytest.raises(ValueError, match=message):
        schedule(**overrides)


def test_config_rejects_duplicates_and_bad_version():
    with pytest.raises(ValueError, match="duplicate"):
        OpsConfig.model_validate(
            {
                "fiesta-ops": 1,
                "schedules": [
                    {"name": "a", "cron": "@daily", "command": ["x"], "expected_interval": "2d"},
                    {"name": "a", "cron": "@daily", "command": ["y"], "expected_interval": "2d"},
                ],
            }
        )
    with pytest.raises(ValueError):
        parse_ops_config("fiesta-ops: 2\nschedules: []\n")
    with pytest.raises(ValueError):
        parse_ops_config("schedules: []\n")


def test_unknown_nodes():
    config = OpsConfig.model_validate(
        {
            "fiesta-ops": 1,
            "schedules": [
                {
                    "name": "a",
                    "node": "magic",
                    "cron": "@daily",
                    "command": ["x"],
                    "expected_interval": "2d",
                },
                {
                    "name": "b",
                    "node": "nonode",
                    "cron": "@daily",
                    "command": ["x"],
                    "expected_interval": "2d",
                },
                {"name": "c", "cron": "@daily", "command": ["x"], "expected_interval": "2d"},
            ],
        }
    )
    assert config.unknown_nodes({"magic"}) == ["b"]


# --- runner -------------------------------------------------------------------


async def test_run_command_success_and_summary_line():
    result = await run_command(
        ["sh", "-c", 'echo working; echo \'{"docs": 12, "errors": 0}\''], max_seconds=10
    )
    assert result.ok and result.exit_code == 0 and not result.timed_out
    assert result.tail == ["working", '{"docs": 12, "errors": 0}']
    assert result.summary == {"docs": 12, "errors": 0}


async def test_run_command_summary_file_wins():
    script = f'echo \'{{"from": "file"}}\' > "${SUMMARY_ENV}"; echo \'{{"from": "stdout"}}\''
    result = await run_command(["sh", "-c", script], max_seconds=10)
    assert result.summary == {"from": "file"}


async def test_run_command_exit_code_and_tail():
    result = await run_command(
        ["sh", "-c", "for i in $(seq 1 100); do echo line $i; done; echo oops >&2; exit 3"],
        max_seconds=10,
    )
    assert not result.ok
    assert result.exit_code == 3
    assert result.reason == "exit code 3"
    assert len(result.tail) == 40
    assert result.tail[0] == "line 62"
    assert result.tail[-1] == "oops"  # stderr is merged
    assert result.summary is None


async def test_run_command_timeout_kills_process_group():
    started = time.monotonic()
    # the child `sleep` would keep running (and keep the pipe open) if only
    # the shell were killed
    result = await run_command(
        ["sh", "-c", "echo begin; sleep 30 & wait"], max_seconds=0.5, kill_grace=2
    )
    assert time.monotonic() - started < 10
    assert result.timed_out and not result.ok
    assert result.reason == "timed out"
    assert result.tail == ["begin"]


async def test_run_command_relative_executable_and_missing(tmp_path):
    tool = tmp_path / "bin" / "tool"
    tool.parent.mkdir()
    tool.write_text("#!/bin/sh\npwd\n")
    tool.chmod(0o755)
    result = await run_command(["bin/tool"], cwd=str(tmp_path), max_seconds=10)
    assert result.ok and result.tail == [str(tmp_path)]

    missing = await run_command(["bin/missing"], cwd=str(tmp_path), max_seconds=10)
    assert not missing.ok and missing.exit_code is None
    assert "could not start" in missing.reason


async def test_run_command_cancel_stops_child():
    task = asyncio.create_task(run_command(["sleep", "30"], max_seconds=60, kill_grace=2))
    await asyncio.sleep(0.3)
    task.cancel()
    started = time.monotonic()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert time.monotonic() - started < 5


def test_summary_from_output():
    assert summary_from_output('{"a": 1}') == {"a": 1}
    assert summary_from_output("[1, 2]") is None
    assert summary_from_output("{not json}") is None
    assert summary_from_output("done") is None
    assert summary_from_output(None) is None


def test_env_file_and_stripped_fiesta_vars(tmp_path):
    (tmp_path / ".env").write_text(
        "# comment\nexport A=1\nB='two words'\nC=\"q\"\nD=plain # trailing\nnot a line\n"
    )
    assert parse_env_file(tmp_path / ".env") == {"A": "1", "B": "two words", "C": "q", "D": "plain"}
    s = schedule(cwd=str(tmp_path), env_file=".env", env={"B": "override"})
    env = build_env(
        s, base={"PATH": "/bin", "FIESTA_DATABASE_URL": "secret", "FIESTA_SLACK_BOT_TOKEN": "xoxb"}
    )
    assert env == {"PATH": "/bin", "A": "1", "B": "override", "C": "q", "D": "plain"}


async def _async_job(n: int):
    await asyncio.sleep(0)
    return {"n": n}


async def _slow_job():
    await asyncio.sleep(5)


def _sync_job():
    raise RuntimeError("boom")


async def test_run_callable():
    ok = await run_callable(f"{__name__}:_async_job", {"n": 3}, max_seconds=5)
    assert ok.ok and ok.summary == {"n": 3}

    slow = await run_callable(f"{__name__}._slow_job", {}, max_seconds=0.2)
    assert slow.timed_out and not slow.ok

    bad = await run_callable(f"{__name__}:_sync_job", {}, max_seconds=5)
    assert not bad.ok and bad.error == "RuntimeError: boom"
    assert any("boom" in line for line in bad.tail)

    missing = await run_callable("fiesta.nothing_here:fn", {}, max_seconds=5)
    assert not missing.ok and "ModuleNotFoundError" in missing.error


# --- Slack ----------------------------------------------------------------------


def test_format_duration():
    assert format_duration(5) == "5s"
    assert format_duration(432) == "7m 12s"
    assert format_duration(7200) == "2h 0m"


def test_format_messages():
    from fiesta.ops.runner import RunResult

    s = schedule(name="osu-mgr-incremental", node="osu-mgr")
    ok = RunResult(
        ok=True,
        duration=432,
        exit_code=0,
        summary={"cruises": 4, "docs": 1200, "detail": {"x": 1}, "mode": "incremental"},
    )
    text = format_success(s, ok, host="marfik3")
    assert text.startswith("✅ *osu-mgr-incremental [osu-mgr]* succeeded in 7m 12s on marfik3")
    assert "cruises: 4, docs: 1200, mode: incremental" in text
    assert "detail" not in text
    assert "(manual)" in format_success(s, ok, host="h", trigger="manual")

    keyed = schedule(summary_keys=["docs", "absent"])
    assert format_summary(ok.summary, keyed.summary_keys) == "docs: 1200"

    failed = RunResult(ok=False, duration=65, exit_code=2, tail=["a", "b"])
    text = format_failure(s, failed, host="marfik3")
    assert text.startswith("❌ *osu-mgr-incremental [osu-mgr]* failed (exit code 2) after 1m 5s")
    assert "Last 2 log lines in the thread." in text

    timed = RunResult(ok=False, duration=7230, timed_out=True)
    assert "timed out after 1h 0m" in format_failure(s, timed, host="h")


def test_format_tail_fits_one_message():
    lines = ["x" * 1000] * 40 + ["has ``` fence"]
    text = format_tail(lines)
    assert text.startswith("```\n") and text.endswith("\n```")
    assert len(text) < 4000
    assert "has ''' fence" in text


def test_format_missed():
    s = schedule(name="osu-mgr-incremental")
    at = datetime(2026, 9, 30, 10, 7, tzinfo=UTC)
    text = format_missed(
        s,
        last_success_at=at,
        last_status="failed",
        last_started_at=at + timedelta(days=1),
        host="fiesta-ct",
    )
    assert "no successful run since 2026-09-30 10:07 UTC" in text
    assert "expected within 26h 0m" in text
    assert "Last run: failed, started 2026-10-01 10:07 UTC." in text


def _transport(handler):
    calls = []

    def record(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    return httpx.MockTransport(record), calls


async def test_slack_post_and_thread():
    transport, calls = _transport(lambda r: httpx.Response(200, json={"ok": True, "ts": "1.2"}))
    notifier = SlackNotifier("xoxb-test", "C123", transport=transport)
    assert await notifier.post("hello") == "1.2"
    assert await notifier.post("reply", thread_ts="1.2") == "1.2"
    first, second = (json.loads(c.content) for c in calls)
    assert calls[0].url == "https://slack.com/api/chat.postMessage"
    assert calls[0].headers["authorization"] == "Bearer xoxb-test"
    assert first == {
        "channel": "C123",
        "text": "hello",
        "unfurl_links": False,
        "unfurl_media": False,
    }
    assert second["thread_ts"] == "1.2"


async def test_slack_failures_never_raise():
    rejected, _ = _transport(
        lambda r: httpx.Response(200, json={"ok": False, "error": "not_in_channel"})
    )
    assert await SlackNotifier("t", "C", transport=rejected).post("x") is None

    def explode(request):
        raise httpx.ConnectError("no route to slack.com")

    down, _ = _transport(explode)
    assert await SlackNotifier("t", "C", transport=down).post("x") is None

    html, _ = _transport(lambda r: httpx.Response(502, text="<html>bad gateway</html>"))
    assert await SlackNotifier("t", "C", transport=html).post("x") is None

    untouched, calls = _transport(lambda r: httpx.Response(200, json={"ok": True}))
    assert await SlackNotifier("", "C", transport=untouched).post("x") is None
    assert await SlackNotifier("t", "", transport=untouched).post("x") is None
    assert calls == []


class FakeNotifier:
    def __init__(self, fail: bool = False):
        self.posts: list[tuple[str, str | None]] = []
        self.fail = fail

    async def post(self, text, *, thread_ts=None):
        self.posts.append((text, thread_ts))
        return None if self.fail else f"ts{len(self.posts)}"


async def test_execute_schedule_success_and_failure():
    notifier = FakeNotifier()
    good = schedule(name="good", command=["sh", "-c", "echo '{\"n\": 1}'"])
    result = await ops_app.execute_schedule(good, notifier, host="h")
    assert result.ok
    assert len(notifier.posts) == 1 and notifier.posts[0][0].startswith("✅ *good*")
    assert "n: 1" in notifier.posts[0][0]

    notifier = FakeNotifier()
    bad = schedule(name="bad", command=["sh", "-c", "echo trace; exit 4"])
    with pytest.raises(ops_app.OpsJobFailed, match="exit code 4"):
        await ops_app.execute_schedule(bad, notifier, host="h")
    (head, head_ts), (tail, tail_ts) = notifier.posts
    assert head.startswith("❌ *bad* failed (exit code 4)") and head_ts is None
    assert tail == "```\ntrace\n```" and tail_ts == "ts1"


async def test_notify_policy_and_slack_down():
    from fiesta.ops.runner import RunResult

    ok = RunResult(ok=True, duration=1)
    bad = RunResult(ok=False, duration=1, exit_code=1, tail=["x"])
    for policy, posts_ok, posts_bad in [("success", 1, 0), ("failure", 0, 2), ("both", 1, 2)]:
        s = schedule(notify=policy)
        n = FakeNotifier()
        await ops_app.notify_result(s, ok, n, host="h")
        assert len(n.posts) == posts_ok
        n = FakeNotifier()
        await ops_app.notify_result(s, bad, n, host="h")
        assert len(n.posts) == posts_bad
    # Slack down: no ts, so no threaded reply, and nothing raises
    n = FakeNotifier(fail=True)
    await ops_app.notify_result(schedule(), bad, n, host="h")
    assert len(n.posts) == 1
    # and a successful job stays successful
    good = schedule(command=["true"])
    assert (await ops_app.execute_schedule(good, SlackNotifier("", ""), host="h")).ok


# --- watchdog -----------------------------------------------------------------


def state(**overrides) -> ScheduleState:
    values = dict(
        name="job",
        job_id=1,
        status="succeeded",
        trigger="cron",
        deferred_at=None,
        started_at=None,
        finished_at=None,
        last_success_at=None,
        first_seen_at=None,
    )
    values.update(overrides)
    return ScheduleState(**values)


def test_watchdog_overdue():
    t0 = datetime(2026, 9, 30, 10, 7, tzinfo=UTC)
    s = schedule()  # expected_interval 26h
    config = OpsConfig.model_validate({"fiesta-ops": 1, "schedules": [s.model_dump()]})

    assert deadline_for(s, None) is None  # never ran in this database: not watched
    assert deadline_for(s, state()) is None
    assert deadline_for(s, state(last_success_at=t0)) == t0 + timedelta(hours=26)
    # never succeeded: counted from its first recorded run
    assert deadline_for(s, state(status="failed", first_seen_at=t0)) == t0 + timedelta(hours=26)

    states = {"job": state(last_success_at=t0, first_seen_at=t0)}
    assert find_overdue(config, states, t0 + timedelta(hours=25)) == []
    [item] = find_overdue(config, states, t0 + timedelta(hours=26))
    assert item.schedule.name == "job" and item.deadline == t0 + timedelta(hours=26)
    assert find_overdue(config, {}, t0 + timedelta(days=30)) == []

    disabled = OpsConfig.model_validate(
        {"fiesta-ops": 1, "schedules": [{**s.model_dump(), "enabled": False}]}
    )
    assert find_overdue(disabled, states, t0 + timedelta(days=3)) == []


def test_watchdog_alert_windows():
    deadline = datetime(2026, 10, 1, 12, 7, tzinfo=UTC)
    tick, realert = 900.0, 86400.0
    # checks every 15 minutes from 11:00 for three days: one alert per day
    checks = [
        datetime(2026, 10, 1, 11, 0, tzinfo=UTC) + timedelta(minutes=15 * i)
        for i in range(4 * 24 * 3)
    ]
    alerts = [c for c in checks if should_alert(c, deadline, tick=tick, realert=realert)]
    assert alerts == [
        datetime(2026, 10, 1, 12, 15, tzinfo=UTC),
        datetime(2026, 10, 2, 12, 15, tzinfo=UTC),
        datetime(2026, 10, 3, 12, 15, tzinfo=UTC),
    ]
    assert not should_alert(deadline - timedelta(seconds=1), deadline, tick=tick, realert=realert)
    # tick 0: a manual check always reports
    assert should_alert(deadline + timedelta(hours=5), deadline, tick=0, realert=realert)


async def test_check_missed_runs_posts_in_window(monkeypatch):
    t0 = datetime(2026, 9, 30, 10, 7, tzinfo=UTC)
    s = schedule()
    config = OpsConfig.model_validate({"fiesta-ops": 1, "schedules": [s.model_dump()]})

    async def fake_states():
        return {
            "job": state(
                status="failed",
                last_success_at=t0,
                first_seen_at=t0,
                started_at=t0 + timedelta(days=1),
            )
        }

    monkeypatch.setattr(ops_app, "schedule_states", fake_states)
    deadline = t0 + timedelta(hours=26)
    n = FakeNotifier()
    overdue = await ops_app.check_missed_runs(
        config, n, now=deadline + timedelta(minutes=5), tick=900, host="h"
    )
    assert len(overdue) == 1 and len(n.posts) == 1
    assert n.posts[0][0].startswith("❌ *job* missed")
    n = FakeNotifier()
    await ops_app.check_missed_runs(
        config, n, now=deadline + timedelta(hours=2), tick=900, host="h"
    )
    assert n.posts == []  # outside the window: logged, not posted


# --- the queue split ------------------------------------------------------------


def test_main_worker_queues_exclude_ops():
    queues = main_worker_queues(["magic", "cdr", "osu-mgr", "magic"])
    assert queues == ["cdr", "magic", "osu-mgr", "default"]
    assert OPS_QUEUE not in queues
    assert OPS_QUEUE not in main_worker_queues(["ops", "default", "sc"])


def test_node_slug_cannot_be_a_reserved_queue():
    from fiesta.nodeconfig import NodeIdentity

    for slug in ("ops", "default"):
        with pytest.raises(ValueError, match="reserved"):
            NodeIdentity(key="X", slug=slug, title="X")
    assert NodeIdentity(key="X", slug="magic", title="X").slug == "magic"


async def test_main_worker_queue_list_and_restart():
    from fiesta.jobs.worker import run_main_worker

    class FakeApp:
        def __init__(self):
            self.runs: list[list[str]] = []
            self.cancelled = 0
            self.opened = False

        @contextlib.asynccontextmanager
        async def open_async(self):
            self.opened = True
            yield self

        async def run_worker_async(self, *, concurrency, queues, install_signal_handlers):
            assert install_signal_handlers is False
            self.runs.append(list(queues))
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.cancelled += 1
                raise

    nodes = [["magic", "cdr"]]

    async def queues_fn():
        return main_worker_queues(nodes[0])

    app, stop = FakeApp(), asyncio.Event()
    runner = asyncio.create_task(
        run_main_worker(
            app, concurrency=1, queues_fn=queues_fn, watch=True, interval=0.05, stop=stop
        )
    )
    await asyncio.sleep(0.2)
    assert app.opened
    assert app.runs == [["cdr", "magic", "default"]]  # no restart without a new queue
    nodes[0] = ["magic", "cdr", "sc"]  # a node published in the admin UI
    await asyncio.sleep(0.3)
    assert app.runs[-1] == ["cdr", "magic", "sc", "default"]
    assert len(app.runs) == 2 and app.cancelled == 1
    stop.set()
    await asyncio.wait_for(runner, 2)
    assert app.cancelled == 2
    assert all(OPS_QUEUE not in run for run in app.runs)


def test_periodic_tasks_only_on_the_ops_worker_app():
    import fiesta.jobs.tasks  # noqa: F401
    from fiesta.jobs.app import get_job_app
    from fiesta.ops.history import RUN_TASK

    config = load_ops_config(CONFIG_DIR / "ops" / "schedules.yaml")
    worker_app = ops_app.build_ops_app(config, periodic=True)
    periodic = worker_app.periodic_registry.periodic_tasks
    assert (RUN_TASK, "osu-mgr-incremental") in periodic
    entry = periodic[(RUN_TASK, "osu-mgr-incremental")]
    assert entry.cron == "0 10 * * *"
    assert entry.configure_kwargs["lock"] == "ops:osu-mgr-incremental"
    assert entry.configure_kwargs["queueing_lock"] == "ops:osu-mgr-incremental"
    assert worker_app.tasks[RUN_TASK].queue == OPS_QUEUE

    assert ops_app.build_ops_app(config, periodic=False).periodic_registry.periodic_tasks == {}
    # the main worker's app defers nothing periodic and has no ops task
    assert get_job_app().periodic_registry.periodic_tasks == {}
    assert RUN_TASK not in get_job_app().tasks
