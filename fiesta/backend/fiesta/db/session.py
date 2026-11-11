"""Engine and sessions.

One engine (one pool) per process; per-node access is a schema_translate_map
layered on top of it, so `get_sessionmaker("magic")` and
`get_sessionmaker("cdr")` share connections but resolve the NODE_SCHEMA token
to different schemas. See fiesta.db.base.
"""

from collections.abc import AsyncIterator
from functools import lru_cache

from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from fiesta.db.base import schema_translate_map
from fiesta.settings import get_settings


@lru_cache
def get_engine() -> AsyncEngine:
    settings = get_settings()
    return create_async_engine(
        settings.sqlalchemy_url,
        connect_args=settings.sqlalchemy_connect_args(),
        pool_pre_ping=True,
    )


@lru_cache
def get_sessionmaker(node_slug: str | None = None) -> async_sessionmaker[AsyncSession]:
    """Sessions bound to one node's schema (or, with None, to the shared
    schema only -- accounts, health checks)."""
    engine = get_engine().execution_options(
        schema_translate_map=schema_translate_map(node_slug, get_settings().db_shared_schema)
    )
    return async_sessionmaker(engine, expire_on_commit=False)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: a session bound to the schema of the node named by
    the `{repository}` path segment, or to the shared schema only (accounts,
    health) on node-less routes."""
    from fiesta.nodeconfig import get_deployment

    slug = None
    if repository := request.path_params.get("repository"):
        try:
            slug = get_deployment().node_for(repository).node.slug
        except KeyError:
            raise HTTPException(404, f"unknown repository {repository!r}") from None
    async with get_sessionmaker(slug)() as session:
        yield session
