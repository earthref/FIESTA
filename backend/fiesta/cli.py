"""FIESTA operational CLI.

    fiesta init          apply DB migrations + procrastinate schema, ensure bucket/index
    fiesta create-user   create an account (--admin for admins)
    fiesta rebuild       rebuild Postgres + OpenSearch from the YAML config + bucket
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

    Safe to run concurrently (multi-node stacks start several backends at
    once): a Postgres advisory lock serializes the schema work."""
    import psycopg

    from fiesta.nodeconfig import get_deployment

    deployment = get_deployment()
    nodes = [deployment.node] if deployment.node else list(deployment.public_api.nodes.values())

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
            await ensure_index(client, node.search_index)
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
    """Rebuild Postgres + OpenSearch from the deployment YAML and the bucket
    (the bucket is the durable record; this wipes and repopulates the
    projections)."""

    async def run() -> None:
        from fiesta.db.session import get_sessionmaker
        from fiesta.nodeconfig import get_deployment
        from fiesta.search.client import get_opensearch
        from fiesta.services.rebuild import rebuild_node

        deployment = get_deployment()
        nodes = [deployment.node] if deployment.node else list(deployment.public_api.nodes.values())
        for node in nodes:
            async with get_sessionmaker(node.node.slug)() as session:
                stats = await rebuild_node(session, node)
            typer.echo(f"{node.node.key}: {stats}")
        await get_opensearch().close()

    if not yes and not typer.confirm("Recreate the search index and repopulate from the bucket?"):
        raise typer.Abort()
    asyncio.run(run())


@app.command()
def worker(concurrency: int = 4) -> None:
    """Run the procrastinate worker for this deployment's node(s).

    Listens to the node's own queue (contribution processing) plus the shared
    "default" queue (emails), so several node workers can share one Postgres
    without picking up each other's contributions."""
    import fiesta.jobs.tasks  # noqa: F401 — register tasks
    from fiesta.jobs.app import get_job_app
    from fiesta.nodeconfig import get_deployment

    deployment = get_deployment()
    nodes = [deployment.node] if deployment.node else list(deployment.public_api.nodes.values())
    queues = [n.node.slug for n in nodes] + ["default"]
    typer.echo(f"worker listening on queues: {queues}")
    get_job_app().run_worker(concurrency=concurrency, queues=queues)


if __name__ == "__main__":
    app()
