from contextlib import suppress

from fastapi import APIRouter
from sqlalchemy import text

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.apps.schemas import HealthOut
from fiesta.search.client import get_opensearch
from fiesta.storage import Storage

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthOut)
async def health(session: SessionDep, node: NodeDep) -> HealthOut:
    database = search = storage = False
    with suppress(Exception):
        await session.execute(text("SELECT 1"))
        database = True
    with suppress(Exception):
        search = bool(await get_opensearch().ping())
    with suppress(Exception):
        async with Storage.for_node(node).client() as s3:
            await s3.list_buckets()
        storage = True
    ok = database and search and storage
    return HealthOut(
        status="ok" if ok else "degraded", database=database, search=search, storage=storage
    )
