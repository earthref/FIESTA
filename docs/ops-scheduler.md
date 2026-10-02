# Scheduled operations (`fiesta ops-worker`)

Sync jobs and background tasks that run on a schedule (the first: the OSU-MGR
OpenSearch incremental update) run on their own host, MARFIK3, and report to
the MARFIK monitor channel in the EarthRef Slack workspace. They use FIESTA's
job queue, procrastinate, and nothing else: no cron table on the host, no
second queue system.

## Pieces

| Piece | Where | What |
|---|---|---|
| `config/ops/schedules.yaml` | this repo | one entry per job, the Slack channel ID, the watchdog settings |
| `fiesta ops-worker` | MARFIK3, systemd | defers each schedule when its cron fires, runs it from the `ops` queue, posts to Slack |
| `fiesta ops-watchdog --post --every 3600` | another host's systemd timer (fiesta-ct) | notices a dead ops worker |
| `fiesta ops-status` / `fiesta ops-run NAME` | anywhere with the database URL | last run per schedule / run one now |
| `FIESTA_SLACK_BOT_TOKEN` | the ops worker's (and watchdog's) environment | the bot token; no token means messages are only logged |

Code: `backend/fiesta/ops/` (config, runner, Slack, watchdog, the procrastinate
app), `backend/fiesta/jobs/queues.py` and `worker.py` (the queue split).

## The schedules file

```yaml
fiesta-ops: 1
slack:
  channel: C0123456789        # channel ID of the MARFIK monitor channel
watchdog:
  cron: "*/15 * * * *"        # how often the ops worker checks for missed runs
  realert: 24h                # repeat an alert this often while it lasts
schedules:
  - name: osu-mgr-incremental # lowercase, digits, hyphens
    node: osu-mgr             # optional: the node the job belongs to; omit for a global job
    cron: "0 10 * * *"        # UTC (procrastinate evaluates cron in UTC)
    command: [.venv/bin/python, osu_mgr_pipeline.py, --incremental, --since, 72h]
    cwd: /srv/osu-mgr-pipeline   # a relative executable is resolved against it
    env_file: null            # optional dotenv merged into the job's environment
    env: {}                   # optional extra variables
    timeout: 2h               # SIGTERM to the job's process group, SIGKILL 30 s later
    notify: both              # success | failure | both
    expected_interval: 26h    # the watchdog's threshold; must exceed the cron's longest gap
    lock: null                # default ops:<name>; share one to serialise several jobs
    summary_keys: []          # which summary fields the success message shows
```

Instead of `command`, a job can name a Python `callable`
(`package.module:function`, sync or async) with `kwargs`; it runs inside the
ops worker, and a dict it returns is the run summary.

The file is loaded and validated by `backend/tests/test_ops.py`, so CI fails on
a bad schedule. A change reaches the ops worker when its checkout is updated
and the service restarted. The default path is `ops/schedules.yaml` beside
`FIESTA_CONFIG_FILE`; `FIESTA_OPS_CONFIG_FILE` overrides it. (`ops` and
`default` are queue names, so no node can be called either; the node config
loader rejects them.)

## How a run goes

1. The ops worker's procrastinate periodic deferrer inserts a
   `fiesta.ops.run_schedule(name=...)` job on the `ops` queue when the cron
   fires. `queueing_lock` keeps at most one run waiting and `lock` keeps two
   from running at once, so a slow run delays the next one and never overlaps
   it. There is no retry: the next scheduled run is the retry. A worker that
   starts more than 10 minutes after a cron time skips that run
   (procrastinate's `max_delay`); the watchdog then reports it.
2. The command runs without a shell, stdout and stderr merged, each line logged
   (the journal on MARFIK3). FIESTA's own `FIESTA_*` variables are removed from
   its environment.
3. On exit 0: ✅ with the duration and the summary (below), if `notify` is
   `success` or `both`. On a non-zero exit, a timeout or a failure to start: ❌
   with the exit code or reason, and the last 40 log lines as a reply in the
   thread, if `notify` is `failure` or `both`; the job is recorded as failed. A
   Slack error never changes the job's outcome.
4. History is procrastinate's `procrastinate_jobs` and `procrastinate_events`
   tables (no table of FIESTA's own): `fiesta ops-status` reads the last run,
   its status and duration, and the last success from them.

**Run summary.** The runner sets `FIESTA_OPS_SUMMARY_JSON` to a file path. A
job that writes a JSON object there has its scalar fields (or `summary_keys`)
shown in the Slack message; failing that, a last stdout line that is a JSON
object is used. The OSU-MGR pipeline does not write one yet.

## Missed runs

A schedule with no successful run within `expected_interval` (counted from its
last success, or from its first recorded run if it never succeeded) is reported
❌ whatever the cause: a run stuck behind a lock, one skipped after an outage,
or a dead worker. The ops worker checks every 15 minutes and also marks runs
orphaned by a dead worker as failed (which releases their lock). A dead ops
worker cannot report itself, so the same check runs from another host as
`fiesta ops-watchdog --post --every 3600` on an hourly timer. Neither keeps
state: an overdue schedule is reported once on the first check after its
deadline and again every `realert`; with both checks running that is one
message from each. A schedule with no run ever recorded in the database is not
watched (`ops-status` shows "no runs yet").

## Why the main worker cannot take ops jobs

`fiesta worker` listens on an explicit list (every node's slug plus `default`),
never on all queues, so it never fetches an `ops` job; and it never imports
`fiesta.ops`, so it has no periodic task to defer. Before this change it
listened on all queues when `FIESTA_NODE` was unset, so that a node published
in the admin UI would be processed without a restart. That still holds: it
re-reads the published nodes every 30 s and, when one adds a queue, stops
gracefully (running jobs finish) and starts again on the longer list.

The ops App (`fiesta.ops.app.build_ops_app`) is a separate procrastinate App
object on the same database and tables. A procrastinate worker defers every
periodic task its App knows, and only `fiesta ops-worker` builds the ops App
with its periodic tasks, so it is the only process that defers ops jobs. Run
exactly one; two would not double-run a schedule (the periodic-defer table and
the locks prevent it), but each would need the jobs' checkouts.

## Commands

```bash
cd backend && FIESTA_CONFIG_FILE=../config/fiesta.yaml uv run fiesta ops-worker
cd backend && FIESTA_CONFIG_FILE=../config/fiesta.yaml uv run fiesta ops-status
cd backend && FIESTA_CONFIG_FILE=../config/fiesta.yaml uv run fiesta ops-run osu-mgr-incremental
cd backend && FIESTA_CONFIG_FILE=../config/fiesta.yaml uv run fiesta ops-watchdog   # exit 1 if overdue
```

`ops-run` defers through the same lock: if a run is already waiting it says so
and exits 1. The run itself happens on the ops worker.

## MARFIK3

The host setup (Slack app, systemd units, env file, network access, the
pipeline checkout) is in [OPERATOR_TODO](OPERATOR_TODO.md), "2026-10-01 —
Scheduled operations on MARFIK3".
