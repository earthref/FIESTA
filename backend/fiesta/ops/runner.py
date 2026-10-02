"""Run one schedule's target: a subprocess (`command`) or a Python callable.

A command runs without a shell in its own process group, stdout and stderr
merged; every line goes to the log (journald on a systemd host) and the last
`tail_lines` are kept for the failure message. On timeout or cancellation the
whole group gets SIGTERM, then SIGKILL after a grace period.

Run summary convention: the runner sets FIESTA_OPS_SUMMARY_JSON to a file path;
a command that writes a JSON object there has it reported. Failing that, a
last stdout line that is a JSON object is the summary. A callable's summary is
its return value when that is a dict.
"""

import asyncio
import contextlib
import importlib
import inspect
import json
import logging
import os
import signal
import tempfile
import time
import traceback
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fiesta.ops.config import Schedule

logger = logging.getLogger(__name__)

SUMMARY_ENV = "FIESTA_OPS_SUMMARY_JSON"
TAIL_LINES = 40
KILL_GRACE = 30.0
# Inherited variables a job never sees: FIESTA's own settings and secrets
# (database URL, Slack token, ...). A job that needs one sets it in `env` or
# its env_file.
_STRIPPED_PREFIXES = ("FIESTA_",)


@dataclass
class RunResult:
    ok: bool
    duration: float
    exit_code: int | None = None
    timed_out: bool = False
    error: str | None = None
    tail: list[str] = field(default_factory=list)
    summary: dict[str, Any] | None = None

    @property
    def reason(self) -> str:
        if self.timed_out:
            return "timed out"
        if self.error:
            return self.error
        if self.exit_code is not None and self.exit_code < 0:
            with contextlib.suppress(ValueError):
                return f"killed by {signal.Signals(-self.exit_code).name}"
        return f"exit code {self.exit_code}"


def parse_env_file(path: Path) -> dict[str, str]:
    """A dotenv file: KEY=VALUE lines, optional `export `, # comments, values
    optionally single- or double-quoted (no interpolation)."""
    env: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not key.replace("_", "").isalnum():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        env[key] = value
    return env


def build_env(schedule: Schedule, base: dict[str, str] | None = None) -> dict[str, str]:
    base = dict(os.environ if base is None else base)
    env = {k: v for k, v in base.items() if not k.startswith(_STRIPPED_PREFIXES)}
    if schedule.env_file:
        path = Path(schedule.env_file)
        if not path.is_absolute() and schedule.cwd:
            path = Path(schedule.cwd) / path
        env.update(parse_env_file(path))
    env.update(schedule.env)
    return env


def summary_from_output(last_line: str | None) -> dict[str, Any] | None:
    if not last_line:
        return None
    text = last_line.strip()
    if not (text.startswith("{") and text.endswith("}")):
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _summary_from_file(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _kill_group(proc: asyncio.subprocess.Process, sig: int) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, sig)


async def _stop(proc: asyncio.subprocess.Process, grace: float) -> None:
    _kill_group(proc, signal.SIGTERM)
    try:
        await asyncio.wait_for(proc.wait(), grace)
    except TimeoutError:
        _kill_group(proc, signal.SIGKILL)
        await proc.wait()


async def run_command(
    argv: list[str],
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    max_seconds: float,
    tail_lines: int = TAIL_LINES,
    kill_grace: float = KILL_GRACE,
    on_line: Callable[[str], None] | None = None,
) -> RunResult:
    started = time.monotonic()
    tail: deque[str] = deque(maxlen=tail_lines)
    last_line: list[str | None] = [None]
    argv = list(argv)
    if cwd and "/" in argv[0] and not os.path.isabs(argv[0]):
        argv[0] = str(Path(cwd) / argv[0])  # `.venv/bin/python` is relative to cwd
    with tempfile.TemporaryDirectory(prefix="fiesta-ops-") as tmp:
        summary_path = Path(tmp) / "summary.json"
        env = {**(os.environ if env is None else env), SUMMARY_ENV: str(summary_path)}
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=cwd,
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
                limit=4 * 1024 * 1024,
            )
        except OSError as exc:
            return RunResult(
                ok=False,
                duration=time.monotonic() - started,
                error=f"could not start {argv[0]!r}"
                + (f" in {cwd}" if cwd else "")
                + f": {exc.strerror or exc}",
            )

        async def read() -> None:
            assert proc.stdout is not None
            while True:
                try:
                    raw = await proc.stdout.readline()
                except ValueError:  # a line over the limit: take what is buffered
                    raw = await proc.stdout.read(64 * 1024)
                if not raw:
                    return
                line = raw.decode(errors="replace").rstrip("\r\n")
                tail.append(line)
                if line.strip():
                    last_line[0] = line
                if on_line:
                    on_line(line)

        reader = asyncio.create_task(read())
        timed_out = False
        try:
            await asyncio.wait_for(asyncio.shield(proc.wait()), max_seconds)
        except TimeoutError:
            timed_out = True
            await _stop(proc, kill_grace)
        except asyncio.CancelledError:
            await _stop(proc, kill_grace)
            reader.cancel()
            raise
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(reader, 10)  # a grandchild may hold the pipe open
        summary = _summary_from_file(summary_path) or summary_from_output(last_line[0])
    code = proc.returncode
    return RunResult(
        ok=not timed_out and code == 0,
        duration=time.monotonic() - started,
        exit_code=code,
        timed_out=timed_out,
        tail=list(tail),
        summary=summary,
    )


def resolve_callable(path: str) -> Callable[..., Any]:
    if ":" in path:
        module_name, attr = path.split(":", 1)
    else:
        module_name, _, attr = path.rpartition(".")
    target = getattr(importlib.import_module(module_name), attr)
    if not callable(target):
        raise TypeError(f"{path} is not callable")
    return target


async def run_callable(
    path: str, kwargs: dict[str, Any], *, max_seconds: float, tail_lines: int = TAIL_LINES
) -> RunResult:
    """A sync callable runs in a thread; on timeout the job fails but the
    thread cannot be stopped, so prefer async callables for long work."""
    started = time.monotonic()
    try:
        target = resolve_callable(path)
        if inspect.iscoroutinefunction(target):
            value = await asyncio.wait_for(target(**kwargs), max_seconds)
        else:
            value = await asyncio.wait_for(asyncio.to_thread(target, **kwargs), max_seconds)
            if inspect.isawaitable(value):
                value = await asyncio.wait_for(value, max_seconds)
    except TimeoutError:
        return RunResult(ok=False, duration=time.monotonic() - started, timed_out=True)
    except Exception as exc:  # noqa: BLE001 - reported, then the job fails
        lines = "".join(traceback.format_exception(exc)).splitlines()
        return RunResult(
            ok=False,
            duration=time.monotonic() - started,
            error=f"{type(exc).__name__}: {exc}",
            tail=lines[-tail_lines:],
        )
    return RunResult(
        ok=True,
        duration=time.monotonic() - started,
        summary=value if isinstance(value, dict) else None,
    )


async def run_schedule_target(schedule: Schedule) -> RunResult:
    if schedule.callable:
        return await run_callable(schedule.callable, schedule.kwargs, max_seconds=schedule.timeout)
    assert schedule.command is not None
    try:
        env = build_env(schedule)
    except OSError as exc:
        return RunResult(ok=False, duration=0.0, error=f"env_file: {exc}")
    log = logging.getLogger(f"fiesta.ops.job.{schedule.name}")
    return await run_command(
        schedule.command,
        cwd=schedule.cwd,
        env=env,
        max_seconds=schedule.timeout,
        on_line=lambda line: log.info("%s", line),
    )
