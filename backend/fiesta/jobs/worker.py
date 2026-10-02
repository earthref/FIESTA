"""`fiesta worker`: the procrastinate worker for node and `default` jobs.

It listens on an explicit queue list (every node's slug + `default`), never
on all queues, because "all" would include `ops`, which belongs to
`fiesta ops-worker` (possibly on another host, with the job's checkout and
credentials). A node published in the admin UI after start gets a new queue:
without FIESTA_NODE the worker re-reads the published nodes every
RECHECK_SECONDS and, when a queue appears, stops gracefully (running jobs
finish) and starts again on the longer list.
"""

import asyncio
import contextlib
import logging
import signal
from collections.abc import Awaitable, Callable

from fiesta.jobs.queues import main_worker_queues
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)

RECHECK_SECONDS = 30.0


async def current_queues() -> list[str]:
    """Queues for the nodes this process serves: FIESTA_NODE's, or every
    published node (Postgres, with node_config_source=db) or YAML node."""
    from fiesta.nodeconfig import get_deployment
    from fiesta.services import node_config

    if node_config.enabled() and not get_settings().node.strip():
        deployment = await node_config.refresh_deployment()  # reloads only on change
    else:
        deployment = get_deployment()
    return main_worker_queues(n.node.slug for n in deployment.node_list)


def watches_new_nodes() -> bool:
    from fiesta.services import node_config

    return node_config.enabled() and not get_settings().node.strip()


async def _new_queues(
    queues: list[str], queues_fn: Callable[[], Awaitable[list[str]]], interval: float
) -> list[str]:
    while True:
        await asyncio.sleep(interval)
        try:
            latest = await queues_fn()
        except Exception as exc:  # noqa: BLE001 - keep serving the queues we have
            logger.warning("could not re-read the node list: %s", exc)
            continue
        if set(latest) - set(queues):
            return latest


async def run_main_worker(
    app,
    *,
    concurrency: int,
    queues_fn: Callable[[], Awaitable[list[str]]] = current_queues,
    watch: bool | None = None,
    interval: float = RECHECK_SECONDS,
    stop: asyncio.Event | None = None,
    on_start: Callable[[list[str]], None] | None = None,
) -> None:
    """Run `app`'s worker on queues_fn()'s queues until SIGINT/SIGTERM (or
    `stop`), restarting it whenever a new queue appears (when watching)."""
    stop = stop or asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, stop.set)
    watch = watches_new_nodes() if watch is None else watch
    queues = await queues_fn()
    async with app.open_async():
        await _serve(app, concurrency, queues, queues_fn, watch, interval, stop, on_start)


async def _serve(app, concurrency, queues, queues_fn, watch, interval, stop, on_start) -> None:
    while True:
        if on_start:
            on_start(queues)
        worker = asyncio.create_task(
            app.run_worker_async(
                concurrency=concurrency, queues=queues, install_signal_handlers=False
            )
        )
        stopping = asyncio.create_task(stop.wait())
        waiters = {worker, stopping}
        changed = None
        if watch:
            changed = asyncio.create_task(_new_queues(queues, queues_fn, interval))
            waiters.add(changed)
        done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
        for task in waiters - {worker}:
            if not task.done():
                task.cancel()
        if worker in done:
            worker.result()  # the worker ended on its own: propagate its error
            return
        worker.cancel()  # procrastinate stops gracefully: running jobs finish
        with contextlib.suppress(asyncio.CancelledError):
            await worker
        if stop.is_set() or changed is None or not changed.done() or changed.cancelled():
            return
        queues = changed.result()
        logger.info("new node queue(s); restarting the worker on %s", queues)
