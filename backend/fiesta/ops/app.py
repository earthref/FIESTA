"""The ops procrastinate App: the same database and tables as the main job app
(`fiesta.jobs.app`), but a separate App object, so the periodic tasks
registered here exist only in the process that builds it with
`periodic=True` -- `fiesta ops-worker`. A procrastinate worker defers every
periodic task of its App, so `fiesta worker` (which never imports this module)
can never defer an ops job, and it never fetches one because it does not
listen on the `ops` queue.

Each schedule is the one task RUN_TASK registered as a periodic task with
`periodic_id` = the schedule name, `lock` (no overlapping runs) and
`queueing_lock` (at most one run waiting) = the schedule's lock key; there is
no retry, the next scheduled run is the retry.
"""

import asyncio
import logging
import time
from datetime import UTC, datetime

import procrastinate
from procrastinate.jobs import Status

from fiesta.jobs.queues import OPS_QUEUE
from fiesta.ops.config import OpsConfig, Schedule
from fiesta.ops.history import RUN_TASK, WATCHDOG_TASK, schedule_states
from fiesta.ops.runner import RunResult, run_schedule_target
from fiesta.ops.slack import (
    SlackNotifier,
    format_failure,
    format_interrupted,
    format_missed,
    format_success,
    format_tail,
    host_label,
)
from fiesta.ops.watchdog import find_overdue, should_alert
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)

WATCHDOG_LOCK = "ops:watchdog"


class OpsJobFailed(Exception):
    """Raised so procrastinate records the run as failed."""


async def notify_result(
    schedule: Schedule,
    result: RunResult,
    notifier: SlackNotifier,
    *,
    host: str,
    trigger: str = "cron",
) -> None:
    if result.ok:
        if schedule.notify in ("success", "both"):
            await notifier.post(format_success(schedule, result, host=host, trigger=trigger))
        return
    if schedule.notify in ("failure", "both"):
        ts = await notifier.post(format_failure(schedule, result, host=host, trigger=trigger))
        if ts and result.tail:
            await notifier.post(format_tail(result.tail), thread_ts=ts)


async def execute_schedule(
    schedule: Schedule,
    notifier: SlackNotifier,
    *,
    trigger: str = "cron",
    host: str | None = None,
) -> RunResult:
    """Run one schedule, report it, and raise OpsJobFailed if it failed."""
    host = host or host_label()
    logger.info("ops %s: starting (%s)", schedule.name, trigger)
    try:
        result = await run_schedule_target(schedule)
    except asyncio.CancelledError:
        # worker shutdown past its grace period, or an abort: the process
        # group is already stopped; say so before procrastinate records it
        await asyncio.shield(
            notifier.post(
                format_interrupted(schedule, host=host, detail="the ops worker stopped the run")
            )
        )
        raise
    logger.info(
        "ops %s: %s in %.0fs%s",
        schedule.name,
        "succeeded" if result.ok else f"failed ({result.reason})",
        result.duration,
        f", summary {result.summary}" if result.summary else "",
    )
    await notify_result(schedule, result, notifier, host=host, trigger=trigger)
    if not result.ok:
        raise OpsJobFailed(f"{schedule.name}: {result.reason}")
    return result


async def fail_stalled_runs(
    app: procrastinate.App, config: OpsConfig, notifier: SlackNotifier, host: str
) -> int:
    """Mark ops runs left `doing` by a dead worker as failed, which releases
    their lock so the next scheduled run can start, and report each one."""
    stalled = await app.job_manager.get_stalled_jobs(queue=OPS_QUEUE)
    for job in stalled:
        await app.job_manager.finish_job(job, status=Status.FAILED, delete_job=False)
        if job.task_name != RUN_TASK:
            continue
        name = (job.task_kwargs or {}).get("name", "?")
        try:
            schedule = config.schedule(name)
        except KeyError:
            logger.warning("stalled ops job %s for unknown schedule %r failed", job.id, name)
            continue
        await notifier.post(
            format_interrupted(
                schedule, host=host, detail=f"job {job.id} lost its worker; marked failed"
            )
        )
    return len(stalled)


async def check_missed_runs(
    config: OpsConfig,
    notifier: SlackNotifier,
    *,
    now: datetime,
    tick: float,
    host: str,
    post: bool = True,
) -> list:
    """Report every overdue schedule whose alert window `now` falls in."""
    overdue = find_overdue(config, await schedule_states(), now)
    for item in overdue:
        message = format_missed(
            item.schedule,
            last_success_at=item.state.last_success_at,
            last_status=item.state.status,
            last_started_at=item.state.started_at,
            host=host,
        )
        if post and should_alert(now, item.deadline, tick=tick, realert=config.watchdog.realert):
            await notifier.post(message)
        else:
            logger.warning("%s", message)
    return overdue


def build_ops_app(config: OpsConfig, *, periodic: bool) -> procrastinate.App:
    """The ops App; periodic=True registers every enabled schedule and the
    watchdog for deferral (only `fiesta ops-worker` passes it)."""
    app = procrastinate.App(
        connector=procrastinate.PsycopgConnector(conninfo=get_settings().procrastinate_dsn)
    )
    notifier = SlackNotifier.from_config(config.slack)

    @app.task(name=RUN_TASK, queue=OPS_QUEUE)
    async def run_schedule(name: str, timestamp: int | None = None, trigger: str = "cron") -> None:
        try:
            schedule = config.schedule(name)
        except KeyError as exc:
            raise OpsJobFailed(f"schedule {name!r} is not in this worker's schedules file") from exc
        await execute_schedule(schedule, notifier, trigger=trigger)

    @app.task(name=WATCHDOG_TASK, queue=OPS_QUEUE)
    async def watchdog(timestamp: int | None = None) -> None:
        host = host_label()
        await fail_stalled_runs(app, config, notifier, host)
        now = datetime.fromtimestamp(timestamp or time.time(), UTC)
        await check_missed_runs(
            config, notifier, now=now, tick=config.watchdog.tick, host=host, post=True
        )

    if periodic:
        for schedule in config.enabled_schedules:
            app.periodic(
                cron=schedule.cron,
                periodic_id=schedule.name,
                lock=schedule.lock_key,
                queueing_lock=schedule.lock_key,
                task_kwargs={"name": schedule.name},
            )(run_schedule)
        # no `lock`: a watchdog run orphaned by a dead worker must not block
        # the next one, which is what fails orphaned runs
        app.periodic(
            cron=config.watchdog.cron, periodic_id="watchdog", queueing_lock=WATCHDOG_LOCK
        )(watchdog)
    return app
