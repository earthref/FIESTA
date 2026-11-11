"""Per-node schema migrations, shared by `fiesta init` and the admin API
(which migrates a node created in the admin UI when it is first published)."""

from pathlib import Path

from alembic.config import Config as AlembicConfig

from alembic import command as alembic_command
from fiesta.settings import get_settings

BACKEND_DIR = Path(__file__).resolve().parents[2]
# Serializes schema work across processes (API and worker containers both run
# `fiesta init` on start; the admin API migrates new nodes).
ADVISORY_LOCK = 715517


def migrate_node(node_slug: str, keep_logging: bool = False) -> None:
    """Apply migrations for one node: its schema, its alembic_version, and
    (first time only) the shared tables. See alembic/env.py. Blocking: run it
    in a thread from async code."""
    config = AlembicConfig(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.attributes["node_slug"] = node_slug
    config.attributes["keep_logging"] = keep_logging
    alembic_command.upgrade(config, "head")


def migrate_node_locked(node_slug: str) -> None:
    """migrate_node under the init advisory lock, keeping the caller's logging."""
    import psycopg

    with psycopg.connect(get_settings().procrastinate_dsn) as lock_conn:
        lock_conn.execute(f"SELECT pg_advisory_lock({ADVISORY_LOCK})")
        migrate_node(node_slug, keep_logging=True)
