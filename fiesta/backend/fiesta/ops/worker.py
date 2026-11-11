"""`fiesta ops-worker`'s loop: the schedules file plus every node's source
schedule (`SourcesConfig.schedules`), re-read every RECHECK_SECONDS.

A node's source schedule is edited in the admin UI (its `legacy.sync`), so a
publication changes it without a restart: procrastinate periodic tasks are
fixed when an App is built, so when the set of schedules changes the worker
stops (once no ops job is running, so a sync in progress is never cut short)
and starts again on a new App.
"""

import asyncio
import contextlib
import logging
import signal
from collections.abc import Awaitable, Callable

from fiesta.jobs.queues import OPS_QUEUE
from fiesta.ops.config import OpsConfig

logger = logging.getLogger(__name__)

RECHECK_SECONDS = 30.0


async def source_nodes() -> list:
    """The nodes as published (Postgres) or, without the database config, the YAML."""
    from fiesta.nodeconfig import get_deployment
    from fiesta.services import node_config

    if node_config.enabled():
        return (await node_config.refresh_deployment()).node_list
    return get_deployment().node_list


async def effective_config(base: OpsConfig) -> OpsConfig:
    return base.with_sources(await source_nodes())


def signature(config: OpsConfig) -> list:
    """What the periodic tasks of an App built from `config` depend on."""
    return [s.model_dump(mode="json") for s in config.schedules]


async def _changed(
    app, config: OpsConfig, config_fn: Callable[[], Awaitable[OpsConfig]], interval: float
) -> OpsConfig:
    while True:
        await asyncio.sleep(interval)
        try:
            latest = await config_fn()
        except Exception as exc:  # noqa: BLE001 - keep running the schedules we have
            logger.warning("could not re-read the node schedules: %s", exc)
            continue
        if signature(latest) == signature(config):
            continue
        running = await app.job_manager.list_jobs_async(queue=OPS_QUEUE, status="doing")
        if not list(running):
            return latest


async def run_ops_worker(
    base: OpsConfig,
    *,
    concurrency: int,
    graceful_timeout: float,
    config_fn: Callable[[], Awaitable[OpsConfig]] | None = None,
    interval: float = RECHECK_SECONDS,
    stop: asyncio.Event | None = None,
    on_start: Callable[[OpsConfig], None] | None = None,
) -> None:
    from fiesta.ops.app import build_ops_app

    config_fn = config_fn or (lambda: effective_config(base))
    stop = stop or asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, stop.set)
    config = await config_fn()
    while True:
        if on_start:
            on_start(config)
        app = build_ops_app(config, periodic=True)
        async with app.open_async():
            worker = asyncio.create_task(
                app.run_worker_async(
                    queues=[OPS_QUEUE],
                    concurrency=concurrency,
                    name="ops",
                    shutdown_graceful_timeout=graceful_timeout,
                    install_signal_handlers=False,
                )
            )
            stopping = asyncio.create_task(stop.wait())
            changed = asyncio.create_task(_changed(app, config, config_fn, interval))
            waiters = {worker, stopping, changed}
            done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
            for task in waiters - {worker}:
                if not task.done():
                    task.cancel()
            if worker in done:
                worker.result()  # the worker ended on its own: propagate its error
                return
            worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await worker
        if stop.is_set() or not changed.done() or changed.cancelled():
            return
        config = changed.result()
        logger.info("ops schedules changed; restarting the ops worker")
