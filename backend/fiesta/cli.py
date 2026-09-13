"""FIESTA operational CLI.

fiesta init          apply DB migrations + procrastinate schema, ensure bucket/index
fiesta create-user   create an account (--admin for admins)
fiesta rebuild       rebuild search from Postgres and immutable bucket objects
fiesta worker        run the procrastinate job worker
"""

import asyncio

import typer
from alembic.config import Config as AlembicConfig

from alembic import command as alembic_command
from fiesta.settings import get_settings

app = typer.Typer(help="FIESTA operations")


def _migrate(node_slug: str) -> None:
    """Apply migrations for one node: its schema, its alembic_version, and
    (first time only) the shared users table. See alembic/env.py."""
    config = AlembicConfig("alembic.ini")
    config.attributes["node_slug"] = node_slug
    alembic_command.upgrade(config, "head")


def _apply_procrastinate_schema() -> None:
    from procrastinate import App, SyncPsycopgConnector

    job_app = App(connector=SyncPsycopgConnector(conninfo=get_settings().procrastinate_dsn))
    with job_app.open():
        job_app.schema_manager.apply_schema()


@app.command()
def init(with_admin: bool = typer.Option(False, help="create an initial admin account")) -> None:
    """Apply migrations, job-queue schema, and ensure search index + bucket.

    Safe to run concurrently (the API and worker containers both run it on
    start): a Postgres advisory lock serializes the schema work."""
    import psycopg

    from fiesta.nodeconfig import get_deployment

    deployment = get_deployment()
    nodes = deployment.node_list

    with psycopg.connect(get_settings().procrastinate_dsn) as lock_conn:
        lock_conn.execute("SELECT pg_advisory_lock(715517)")
        for node in nodes:
            _migrate(node.node.slug)
            typer.echo(f"migrated schema {node.node.slug!r}")
        try:
            _apply_procrastinate_schema()
            typer.echo("procrastinate schema applied")
        except Exception as exc:  # already applied
            typer.echo(f"procrastinate schema: {exc}")

    async def ensure() -> None:
        from fiesta.search.client import get_opensearch
        from fiesta.search.index import ensure_index
        from fiesta.storage import Storage

        client = get_opensearch()
        for node in nodes:
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

    async def run() -> None:
        from sqlalchemy import select

        from fiesta.db.models import User
        from fiesta.db.session import get_sessionmaker
        from fiesta.security import hash_password

        async with get_sessionmaker(None)() as session:
            existing = (
                await session.execute(select(User).where(User.email == email))
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
    "default" queue (emails)."""
    import fiesta.jobs.tasks  # noqa: F401 — register tasks
    from fiesta.jobs.app import get_job_app
    from fiesta.nodeconfig import get_deployment

    deployment = get_deployment()
    nodes = deployment.node_list
    queues = [n.node.slug for n in nodes] + ["default"]
    typer.echo(f"worker listening on queues: {queues}")
    import subprocess
    import sys

    process = subprocess.Popen([sys.executable, "-m", "fiesta.cli", "outbox-worker"])
    try:
        get_job_app().run_worker(concurrency=concurrency, queues=queues)
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


@app.command("outbox-worker")
def outbox_worker():
    from fiesta.nodeconfig import get_deployment
    from fiesta.services.outbox import serve

    deployment = get_deployment()
    nodes = deployment.node_list
    asyncio.run(serve(nodes))


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
def legacy_inventory(node: str, out: str = typer.Option(..., "--out", help="snapshot directory")):
    """Snapshot NODE's legacy OpenSearch index + S3 buckets into OUT/inventory.json and owners.json.

    Read-only against the legacy sources; review the output, then `ensure-owners`
    and `sync-legacy`. Needs the node YAML's `legacy:` block.
    """
    import json
    from pathlib import Path

    from fiesta.nodeconfig import get_deployment
    from fiesta.services.legacy_inventory import build_inventory

    target = get_deployment().node_for(node)
    out_dir = Path(out).resolve()

    async def run():
        from fiesta.search.client import get_opensearch

        try:
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


if __name__ == "__main__":
    app()
