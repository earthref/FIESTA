"""FIESTA operational CLI.

fiesta init          apply DB migrations + procrastinate schema, ensure bucket/index
fiesta create-user   create an account (--admin for admins)
fiesta rebuild       rebuild search from Postgres and immutable bucket objects
fiesta worker        run the procrastinate job worker (node queues + default)
fiesta enrich-references   fetch every reference DOI's publication metadata
fiesta ops-worker    run scheduled operations (config/ops/schedules.yaml, `ops` queue)
fiesta ops-status    last run of every schedule; ops-run NAME defers one now
fiesta ops-watchdog  check for missed scheduled runs (--post reports them to Slack)
"""

import asyncio
import json

import typer

from fiesta.db.migrate import ADVISORY_LOCK, migrate_node, migrate_node_locked
from fiesta.settings import get_settings

app = typer.Typer(help="FIESTA operations")


def _apply_procrastinate_schema() -> None:
    from procrastinate import App, SyncPsycopgConnector

    job_app = App(connector=SyncPsycopgConnector(conninfo=get_settings().procrastinate_dsn))
    with job_app.open():
        job_app.schema_manager.apply_schema()


@app.command()
def init(with_admin: bool = typer.Option(False, help="create an initial admin account")) -> None:
    """Apply migrations, job-queue schema, and ensure search index + bucket.

    Safe to run concurrently (the API and worker containers both run it on
    start): a Postgres advisory lock serializes the schema work.

    With FIESTA_NODE_CONFIG_SOURCE=db (the default) it then records every
    YAML node in config/ as a published revision unless Postgres has already
    published that exact tree, and also brings up nodes that so far exist only
    in Postgres (published in the admin UI, not yet merged into git)."""
    import psycopg

    from fiesta.nodeconfig import get_deployment, load_deployment

    deployment = get_deployment()
    nodes = deployment.node_list

    with psycopg.connect(get_settings().procrastinate_dsn) as lock_conn:
        lock_conn.execute(f"SELECT pg_advisory_lock({ADVISORY_LOCK})")
        for node in nodes:
            migrate_node(node.node.slug)
            typer.echo(f"migrated schema {node.node.slug!r}")
        try:
            _apply_procrastinate_schema()
            typer.echo("procrastinate schema applied")
        except Exception as exc:  # already applied
            typer.echo(f"procrastinate schema: {exc}")

    async def ensure() -> None:
        from fiesta.db.session import get_sessionmaker
        from fiesta.search.client import get_opensearch
        from fiesta.search.index import ensure_index
        from fiesta.services import node_config
        from fiesta.storage import Storage

        served = nodes
        if node_config.enabled():
            async with get_sessionmaker(None)() as session:
                imported = await node_config.import_repo_nodes(session, load_deployment(only=None))
                await session.commit()
            typer.echo(f"node configuration imported from config/: {imported or 'none changed'}")
            served = (await node_config.refresh_deployment(force=True)).node_list
            migrated = {n.node.slug for n in nodes}
            for node in served:
                if node.node.slug not in migrated:
                    await asyncio.to_thread(migrate_node_locked, node.node.slug)
                    typer.echo(f"migrated schema {node.node.slug!r} (published in the admin UI)")

        client = get_opensearch()
        for node in served:
            await Storage.for_node(node).ensure_bucket()
            try:
                await ensure_index(client, node.search_index)
            except Exception:
                typer.echo(f"search unavailable for {node.node.slug}; outbox will retry", err=True)
            typer.echo(
                f"ensured bucket {node.bucket!r} (prefix {node.storage_prefix!r}) "
                f"and index {node.search_index!r}"
            )
        await client.close()

    asyncio.run(ensure())
    if with_admin:
        create_user("admin@example.com", "Administrator", "changeme", admin=True)


@app.command()
def create_user(
    email: str,
    name: str,
    password: str = typer.Option(..., prompt=True, hide_input=True),
    admin: bool = False,
) -> None:
    """Create an account."""

    email = email.strip().lower()

    async def run() -> None:
        from sqlalchemy import func, select

        from fiesta.db.models import User
        from fiesta.db.session import get_sessionmaker
        from fiesta.security import hash_password

        async with get_sessionmaker(None)() as session:
            existing = (
                await session.execute(select(User).where(func.lower(User.email) == email))
            ).scalar_one_or_none()
            if existing:
                typer.echo(f"user {email} already exists (id {existing.id})")
                return
            user = User(
                email=email, name=name, password_hash=hash_password(password), is_admin=admin
            )
            session.add(user)
            await session.commit()
            typer.echo(f"created user {email} (id {user.id})")

    asyncio.run(run())


@app.command()
def rebuild(
    yes: bool = typer.Option(False, "--yes", help="skip confirmation"),
) -> None:
    """Build a new search index from Postgres/revisions, then switch its alias."""

    async def run() -> None:
        from fiesta.db.session import get_sessionmaker
        from fiesta.nodeconfig import get_deployment
        from fiesta.search.client import get_opensearch
        from fiesta.services.rebuild import rebuild_node

        deployment = get_deployment()
        nodes = deployment.node_list
        for node in nodes:
            async with get_sessionmaker(node.node.slug)() as session:
                stats = await rebuild_node(session, node)
            typer.echo(f"{node.node.key}: {stats}")
        await get_opensearch().close()

    if not yes and not typer.confirm(
        "Rebuild search from Postgres and revision files, then switch the index alias?"
    ):
        raise typer.Abort()
    asyncio.run(run())


@app.command()
def worker(concurrency: int = 4) -> None:
    """Run the procrastinate worker for every enabled node.

    Listens to each node's own queue (contribution processing) plus the shared
    "default" queue (emails, node configuration publication) -- an explicit
    list, never every queue, so it leaves the "ops" queue to `fiesta
    ops-worker`. Without FIESTA_NODE it re-reads the published nodes and
    restarts itself on a longer list when a node published in the admin UI
    adds a queue (see fiesta.jobs.worker)."""
    import subprocess
    import sys

    import fiesta.jobs.tasks  # noqa: F401 — register tasks
    from fiesta.jobs.app import get_job_app
    from fiesta.jobs.worker import run_main_worker

    process = subprocess.Popen([sys.executable, "-m", "fiesta.cli", "outbox-worker"])
    try:
        asyncio.run(
            run_main_worker(
                get_job_app(),
                concurrency=concurrency,
                on_start=lambda queues: typer.echo(f"worker listening on queues: {queues}"),
            )
        )
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


@app.command("drain-outbox")
def drain_outbox():
    """Retry pending revision processing/indexing once (also useful in CI)."""
    from fiesta.nodeconfig import get_deployment
    from fiesta.services.outbox import drain

    async def run():
        deployment = get_deployment()
        nodes = deployment.node_list
        for node in nodes:
            typer.echo(f"{node.node.slug}: {await drain(node)}")
        from fiesta.search.client import get_opensearch

        await get_opensearch().close()

    asyncio.run(run())


@app.command("enrich-references")
def enrich_references(
    refresh: bool = typer.Option(False, help="fetch every known DOI again, not just new ones"),
    batch: int = typer.Option(20, help="DOIs fetched per round"),
):
    """Fetch the publication metadata (Crossref, then DataCite) of every
    contribution's reference DOI and set it on their search docs. The outbox
    worker does this for new DOIs and monthly refreshes; this is the backfill."""
    from fiesta.search.client import get_opensearch
    from fiesta.services import references

    async def run():
        try:
            for slug, n in (await references.request_all()).items():
                typer.echo(f"{slug}: {n} reference DOIs")
            if refresh:
                typer.echo(f"{await references.refresh_all()} fetched DOIs made due")
            totals = {"ok": 0, "not_found": 0, "error": 0, "updated": 0}
            while True:
                counts = await references.drain(batch)
                if not any(counts[k] for k in ("ok", "not_found", "error")):
                    break
                totals = {k: totals[k] + counts[k] for k in totals}
                typer.echo(
                    f"fetched {totals['ok']} (not found {totals['not_found']}, "
                    f"errors {totals['error']}); {totals['updated']} contributions updated"
                )
        finally:
            await get_opensearch().close()

    asyncio.run(run())


@app.command("outbox-worker")
def outbox_worker():
    from fiesta.services.outbox import serve

    asyncio.run(serve())


@app.command()
def seed():
    """Load configured development fixtures; refuses remote infrastructure."""
    from fiesta.nodeconfig import get_deployment
    from fiesta.services.seed import require_local, seed_node

    require_local()

    async def run():
        deployment = get_deployment()
        nodes = deployment.node_list
        from fiesta.search.client import get_opensearch

        try:
            for node in nodes:
                typer.echo(f"{node.node.slug}: {await seed_node(node)}")
        finally:
            await get_opensearch().close()

    asyncio.run(run())


@app.command("sync-legacy")
def sync_legacy(inventory: str, apply: bool = False):
    """Verify an inventory, or apply it with --apply. Repeat for incremental sync."""
    import json
    from pathlib import Path

    from fiesta.nodeconfig import get_deployment
    from fiesta.services.legacy import load_inventory, sync_inventory

    inventory = str(Path(inventory).resolve())
    config = load_inventory(inventory)
    deployment = get_deployment()
    node = deployment.node_for(config.node)
    result = asyncio.run(sync_inventory(node, inventory, apply=apply))
    typer.echo(json.dumps(result, indent=2))
    if result["errors"]:
        raise typer.Exit(1)


@app.command("legacy-inventory")
def legacy_inventory(
    node: str,
    out: str = typer.Option(..., "--out", help="snapshot directory"),
    download: bool = typer.Option(True, help="earthref-cgi: download the record files"),
    max_total_gb: float = typer.Option(
        20, help="earthref-cgi: refuse to download more than this (estimated) in one run"
    ),
    max_file_mb: float = typer.Option(
        0, help="earthref-cgi: defer files listed at over this size (0: no limit)"
    ),
    owner_map: str | None = typer.Option(
        None,
        "--owner-map",
        help="JSON of owner_handles/owner_names/owner_overrides/default_owner merged "
        "over the YAML's legacy block (keep it in the gitignored snapshot directory)",
    ),
):
    """Snapshot NODE's legacy source into OUT/inventory.json and owners.json.

    `legacy.kind: meteor` reads the legacy OpenSearch index + S3 buckets;
    `earthref-cgi` crawls the public record pages (cached under OUT, so a re-run
    resumes). Read-only against the legacy sources; review the output, then
    `ensure-owners` and `sync-legacy`. Needs the node YAML's `legacy:` block.
    """
    import json
    from pathlib import Path

    from fiesta.nodeconfig import get_deployment

    target = get_deployment().node_for(node)
    if target.legacy is None:
        raise typer.BadParameter(f"{node} has no `legacy:` block")
    out_dir = Path(out).resolve()
    if owner_map:  # operator owner mapping for this run, never in checked-in config
        legacy = target.legacy.with_owner_map(json.loads(Path(owner_map).read_text()))
        target = target.model_copy(update={"legacy": legacy})

    async def run():
        from fiesta.search.client import get_opensearch

        try:
            if target.legacy.kind == "earthref-cgi":
                from fiesta.services.legacy_cgi import build_inventory as build_cgi

                return await build_cgi(
                    target,
                    out_dir,
                    download=download,
                    max_total_bytes=int(max_total_gb * 1000**3),
                    max_file_bytes=int(max_file_mb * 1024**2) or None,
                )
            from fiesta.services.legacy_inventory import build_inventory

            return await build_inventory(target, out_dir)
        finally:
            await get_opensearch().close()

    result = asyncio.run(run())
    typer.echo(json.dumps(result, indent=2))
    if result["errors"]:
        raise typer.Exit(1)


@app.command("ensure-owners")
def ensure_owners_command(node: str, owners: str, apply: bool = False):
    """Create the accounts an inventory's owners.json needs (no passwords); --apply to write."""
    import json
    from pathlib import Path

    from fiesta.nodeconfig import get_deployment
    from fiesta.services.legacy_inventory import ensure_owners

    target = get_deployment().node_for(node)
    wanted = json.loads(Path(owners).read_text())
    result = asyncio.run(ensure_owners(target, wanted, apply=apply))
    typer.echo(json.dumps(result, indent=2))


@app.command("sync-legacy-users")
def sync_legacy_users_command(node: str, apply: bool = False):
    """Copy every legacy er_users account, with its bcrypt password, into the shared
    users table; --apply to write. Re-run until cutover to pick up password changes.

    Accounts are shared, so any node whose YAML has a `legacy:` block will do (it
    names the users index).
    """
    import json

    from fiesta.nodeconfig import get_deployment
    from fiesta.services.legacy_inventory import sync_legacy_users

    target = get_deployment().node_for(node)

    async def run():
        from fiesta.search.client import get_opensearch

        try:
            return await sync_legacy_users(target, apply=apply)
        finally:
            await get_opensearch().close()

    typer.echo(json.dumps(asyncio.run(run()), indent=2))


@app.command("verify-storage")
def verify_storage_command():
    """Verify revision pointers, immutable manifests, files and validation reports."""
    import json

    from fiesta.db.session import get_sessionmaker
    from fiesta.nodeconfig import get_deployment
    from fiesta.services.recovery import verify_storage

    async def run():
        deployment = get_deployment()
        nodes = deployment.node_list
        failed = False
        for node in nodes:
            async with get_sessionmaker(node.node.slug)() as session:
                result = await verify_storage(session, node)
            typer.echo(json.dumps({"node": node.node.slug, **result}, indent=2))
            failed |= bool(result["errors"])
        return failed

    if asyncio.run(run()):
        raise typer.Exit(1)


@app.command("verify-index")
def verify_index_command(fix: bool = False):
    """Compare live contributions with their search docs (run after draining the
    outbox); --fix re-indexes missing ones and removes orphans, one at a time.
    Exits 1 when anything is missing or orphaned and --fix was not given."""
    from fiesta.db.session import get_sessionmaker
    from fiesta.nodeconfig import get_deployment
    from fiesta.search.client import get_opensearch
    from fiesta.services.rebuild import verify_index

    async def run():
        unhealthy = False
        for node in get_deployment().node_list:
            async with get_sessionmaker(node.node.slug)() as session:
                result = await verify_index(session, node, fix=fix)
            counts = {k: len(v) if isinstance(v, list) else v for k, v in result.items()}
            sample = {k: result[k][:20] for k in ("missing", "orphaned", "unparseable")}
            typer.echo(json.dumps({"node": node.node.slug, **counts, "sample": sample}))
            unhealthy |= not fix and bool(result["missing"] or result["orphaned"])
        await get_opensearch().close()
        return unhealthy

    if asyncio.run(run()):
        raise typer.Exit(1)


@app.command("backfill-revisions")
def backfill_revisions():
    """Preserve pre-Phase-M FIESTA canonical files as initial immutable revisions."""
    from sqlalchemy import select

    from fiesta.db.models import Contribution
    from fiesta.db.session import get_sessionmaker
    from fiesta.nodeconfig import get_deployment
    from fiesta.services.revisions import save_revision

    async def run():
        deployment = get_deployment()
        nodes = deployment.node_list
        for node in nodes:
            count = 0
            async with get_sessionmaker(node.node.slug)() as session:
                rows = (
                    (
                        await session.execute(
                            select(Contribution)
                            .where(
                                Contribution.head_revision.is_(None),
                                Contribution.filename.is_not(None),
                            )
                            .order_by(Contribution.id)
                        )
                    )
                    .scalars()
                    .all()
                )
                for c in rows:
                    await save_revision(
                        session,
                        node,
                        c,
                        c.contributor_id,
                        expected_revision=None,
                        request_key=f"backfill:{c.id}",
                        operation="backfill",
                    )
                    if c.is_activated:
                        c.published_revision = c.head_revision
                    await session.commit()
                    count += 1
            typer.echo(f"{node.node.slug}: backfilled {count}")

    asyncio.run(run())


@app.command("stamp-ids")
def stamp_ids_command(apply: bool = False):
    """Backfill download-only contribution_id/row_id into stored contribution files
    saved before every save wrote them (dry run unless --apply; one commit each)."""
    from sqlalchemy import select

    from fiesta.db.models import Contribution
    from fiesta.db.session import get_sessionmaker
    from fiesta.nodeconfig import get_deployment
    from fiesta.services.revisions import stamp_ids_revision

    async def run():
        for node in get_deployment().node_list:
            sessionmaker = get_sessionmaker(node.node.slug)
            async with sessionmaker() as session:
                ids = (
                    await session.execute(
                        select(Contribution.id)
                        .where(
                            Contribution.head_revision.is_not(None),
                            Contribution.deleted_at.is_(None),
                        )
                        .order_by(Contribution.id)
                    )
                ).scalars()
                ids = list(ids)
            report = {"stamped" if apply else "planned": 0, "unchanged": 0, "errors": []}
            for cid in ids:
                async with sessionmaker() as session:
                    try:
                        c = await session.get(Contribution, cid)
                        if await stamp_ids_revision(session, node, c, apply=apply):
                            await session.commit()
                            report["stamped" if apply else "planned"] += 1
                        else:
                            report["unchanged"] += 1
                    except Exception as exc:
                        await session.rollback()
                        report["errors"].append({"id": cid, "error": str(exc)})
            typer.echo(f"{node.node.slug}: {json.dumps(report)}")

    asyncio.run(run())


def _ops_logging() -> None:
    """Job output, Slack fallbacks and procrastinate's own log at INFO (the
    ops worker's stdout is the journal on a systemd host)."""
    import logging

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )


def _ops_config():
    from fiesta.ops.config import load_ops_config

    try:
        return load_ops_config()
    except (OSError, ValueError) as exc:
        typer.echo(f"schedules file: {exc}", err=True)
        raise typer.Exit(2) from exc


@app.command("ops-worker")
def ops_worker(
    concurrency: int = typer.Option(2, help="schedules that may run at the same time"),
    graceful_timeout: float = typer.Option(
        30, help="seconds a stop waits for running jobs before stopping them"
    ),
):
    """Run scheduled operations: defer every enabled schedule in the schedules
    file (FIESTA_OPS_CONFIG_FILE, default config/ops/schedules.yaml) when its
    cron fires, run them from the `ops` queue, and report to Slack. The only
    process that defers ops jobs; run exactly one (see docs/ops-scheduler.md)."""
    from fiesta.jobs.queues import OPS_QUEUE
    from fiesta.nodeconfig import load_deployment
    from fiesta.ops.app import build_ops_app
    from fiesta.ops.config import ops_config_path

    _ops_logging()
    config = _ops_config()
    try:
        slugs = {n.node.slug for n in load_deployment(only=None).node_list}
        for name in config.unknown_nodes(slugs):
            typer.echo(f"warning: schedule {name!r} names a node not in the deployment", err=True)
    except (OSError, ValueError) as exc:
        typer.echo(f"warning: deployment not loaded, node names unchecked: {exc}", err=True)
    if not (get_settings().slack_bot_token and config.slack.channel):
        typer.echo("Slack not configured (token or channel): status is logged only", err=True)
    typer.echo(f"ops worker: {ops_config_path()}")
    for s in config.schedules:
        state = "enabled" if s.enabled else "disabled"
        typer.echo(f"  {s.name:<28} {s.cron:<16} UTC  {state}")
    job_app = build_ops_app(config, periodic=True)
    job_app.run_worker(
        queues=[OPS_QUEUE],
        concurrency=concurrency,
        name="ops",
        shutdown_graceful_timeout=graceful_timeout,
    )


@app.command("ops-status")
def ops_status():
    """The last run of every schedule (from procrastinate's job tables)."""
    from datetime import UTC, datetime

    from fiesta.ops.history import schedule_states
    from fiesta.ops.slack import format_duration
    from fiesta.ops.watchdog import deadline_for

    config = _ops_config()
    states = asyncio.run(schedule_states())
    now = datetime.now(UTC)

    def when(moment):
        return moment.astimezone(UTC).strftime("%Y-%m-%d %H:%M") if moment else "-"

    header = (
        f"{'SCHEDULE':<26} {'CRON (UTC)':<14} {'LAST START':<17} {'STATUS':<10} "
        f"{'DURATION':<9} {'LAST SUCCESS':<17} WATCHDOG"
    )
    typer.echo(header)
    for s in config.schedules:
        state = states.get(s.name)
        deadline = deadline_for(s, state)
        if not s.enabled:
            watch = "disabled"
        elif deadline is None:
            watch = "no runs yet"
        elif now >= deadline:
            watch = f"OVERDUE since {when(deadline)}"
        else:
            watch = f"ok until {when(deadline)}"
        duration = state.duration if state else None
        typer.echo(
            f"{s.name:<26} {s.cron:<14} {when(state and state.started_at):<17} "
            f"{(state.status if state else '-'):<10} "
            f"{(format_duration(duration) if duration is not None else '-'):<9} "
            f"{when(state and state.last_success_at):<17} {watch}"
        )
    for name in sorted(set(states) - {s.name for s in config.schedules}):
        typer.echo(f"{name:<26} (not in the schedules file; last status {states[name].status})")


@app.command("ops-run")
def ops_run(name: str):
    """Defer one schedule now (it runs on the ops worker, under the schedule's
    lock, and reports to Slack like a scheduled run)."""
    from procrastinate.exceptions import AlreadyEnqueued

    from fiesta.ops.app import build_ops_app
    from fiesta.ops.history import RUN_TASK

    config = _ops_config()
    try:
        schedule = config.schedule(name)
    except KeyError as exc:
        names = ", ".join(s.name for s in config.schedules)
        typer.echo(f"no schedule {name!r} (have: {names})", err=True)
        raise typer.Exit(2) from exc
    job_app = build_ops_app(config, periodic=False)

    async def run():
        async with job_app.open_async():
            return (
                await job_app.tasks[RUN_TASK]
                .configure(lock=schedule.lock_key, queueing_lock=schedule.lock_key)
                .defer_async(name=schedule.name, trigger="manual")
            )

    try:
        job_id = asyncio.run(run())
    except AlreadyEnqueued as exc:
        typer.echo(f"{name}: a run is already waiting in the queue", err=True)
        raise typer.Exit(1) from exc
    typer.echo(f"{name}: deferred as job {job_id} on the ops queue")


@app.command("ops-watchdog")
def ops_watchdog(
    post: bool = typer.Option(False, help="post missed runs to Slack (else just print)"),
    every: float = typer.Option(
        0,
        help="seconds between runs of this check (a timer's period): posts only on the "
        "first check after a deadline and every `watchdog.realert` after; 0 posts every time",
    ),
):
    """Check every schedule for a missed run; exit 1 if any is overdue. Run it
    from another host's timer with --post --every 3600 so a dead ops worker
    is noticed (the ops worker's own check cannot report its own death)."""
    import time
    from datetime import UTC, datetime

    from fiesta.ops.app import check_missed_runs
    from fiesta.ops.slack import SlackNotifier, host_label

    _ops_logging()
    config = _ops_config()
    now_ts = time.time()
    if every > 0:
        now_ts -= now_ts % every  # align, so the alert window holds exactly one check
    overdue = asyncio.run(
        check_missed_runs(
            config,
            SlackNotifier.from_config(config.slack),
            now=datetime.fromtimestamp(now_ts, UTC),
            tick=every,
            host=host_label(),
            post=post,
        )
    )
    for item in overdue:
        typer.echo(
            f"OVERDUE {item.schedule.name} since {item.deadline.astimezone(UTC):%Y-%m-%d %H:%M} UTC"
        )
    if not overdue:
        typer.echo("no missed runs")
    raise typer.Exit(1 if overdue else 0)


if __name__ == "__main__":
    app()
