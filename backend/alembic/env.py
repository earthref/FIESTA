"""Alembic environment.

Migrations run once PER NODE (`fiesta init` loops over the deployment's
nodes): the node's slug arrives in config.attributes["node_slug"], its schema
is created if missing, the NODE_SCHEMA/SHARED_SCHEMA tokens are mapped for
that node, and the node keeps its own alembic_version table inside its
schema. Shared-schema objects (users) are created idempotently by the
migration that owns them, so whichever node migrates first creates them.
"""

import asyncio
from logging.config import fileConfig

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context
from fiesta.db.base import Base, schema_translate_map
from fiesta.db.models import *  # noqa: F401,F403 — register models on Base.metadata
from fiesta.settings import get_settings

config = context.config
# The API migrates a node created in the admin UI in-process; it keeps its own
# logging configuration (fileConfig would disable uvicorn's loggers).
if config.config_file_name is not None and not config.attributes.get("keep_logging"):
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _node_slug() -> str:
    slug = config.attributes.get("node_slug") or context.get_x_argument(as_dictionary=True).get(
        "node"
    )
    if not slug:
        raise RuntimeError(
            "migrations run per node: use `fiesta init`, or `alembic -x node=<slug> upgrade head`"
        )
    return slug


def run_migrations_offline() -> None:
    raise NotImplementedError(
        "offline (--sql) mode is not supported: schemas are resolved per node at runtime"
    )


def do_run_migrations(connection, slug: str) -> None:
    settings = get_settings()
    # Resolved schema names for migrations. Alembic's ALTER TABLE family
    # (add_column / alter_column / drop_column) renders the schema literally
    # and bypasses schema_translate_map, so migrations that alter a table
    # must use these instead of the NODE_SCHEMA / SHARED_SCHEMA tokens.
    config.attributes["node_schema"] = slug
    config.attributes["shared_schema"] = settings.db_shared_schema
    connection = connection.execution_options(
        schema_translate_map=schema_translate_map(slug, settings.db_shared_schema)
    )
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        version_table_schema=slug,
        include_schemas=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    settings = get_settings()
    slug = _node_slug()
    engine = create_async_engine(
        settings.sqlalchemy_url, connect_args=settings.sqlalchemy_connect_args()
    )
    async with engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{slug}"'))
        await connection.execute(
            text(f'CREATE SCHEMA IF NOT EXISTS "{settings.db_shared_schema}"')
        )
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations, slug)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
