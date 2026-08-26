"""Public search + contribution retrieval for the node frontend."""

import uuid as uuid_mod

from fastapi import APIRouter, HTTPException, Query, Response
from opensearchpy.exceptions import NotFoundError

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.apps.schemas import SearchPage
from fiesta.db.models import Contribution
from fiesta.search.client import get_opensearch
from fiesta.search.queries import build_search_body
from fiesta.services.contributions import load_file

router = APIRouter(tags=["search"])


def _all_levels(node) -> list:
    from fiesta.plugins import active_plugins

    levels = list(node.search.levels)
    for plugin in active_plugins(node):
        levels.extend(plugin.search_levels(node))
    return levels


def _level_tables(node) -> set[str]:
    return {lvl.table for lvl in _all_levels(node)} | set(node.search.extra_types)


@router.get("/search/{table}", response_model=SearchPage)
async def search(
    node: NodeDep,
    table: str,
    query: str | None = None,
    size: int = Query(10, ge=1, le=1000),
    from_: int = Query(0, ge=0, alias="from"),
    facets: bool = False,
) -> SearchPage:
    if table not in _level_tables(node):
        raise HTTPException(404, f"unknown search table {table!r}")
    level = next((lvl for lvl in _all_levels(node) if lvl.table == table), None)
    body = build_search_body(
        table=table,
        query=query,
        size=size,
        from_=from_,
        facets=node.search.facets if facets else None,
        count_field=level.count_field if level else None,
    )
    try:
        response = await get_opensearch().search(index=node.search.index, body=body)
    except NotFoundError:
        return SearchPage(total=0, results=[], aggregations={} if facets else None)
    hits = response["hits"]
    aggregations = None
    if facets and "aggregations" in response:
        aggregations = {
            name: [
                {"key": b["key"], "doc_count": b["doc_count"]}
                for b in agg.get("buckets", [])
            ]
            for name, agg in response["aggregations"].items()
        }
    total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]
    return SearchPage(
        total=total, results=[h["_source"] for h in hits["hits"]], aggregations=aggregations
    )


async def _get_visible_contribution(
    session, node, contribution_id: int, private_key: str | None
) -> Contribution:
    contribution = await session.get(Contribution, contribution_id)
    if contribution is None or contribution.node != node.node.slug:
        raise HTTPException(404, f"contribution {contribution_id} not found")
    if not contribution.is_activated:
        try:
            supplied = uuid_mod.UUID(private_key) if private_key else None
        except ValueError:
            supplied = None
        if supplied != contribution.private_key:
            raise HTTPException(404, f"contribution {contribution_id} not found")
    return contribution


@router.get("/contributions/{contribution_id}")
async def get_contribution(
    session: SessionDep, node: NodeDep, contribution_id: int, private_key: str | None = None
) -> dict:
    contribution = await _get_visible_contribution(session, node, contribution_id, private_key)
    body = build_search_body(table="contribution", query=f'id:"{contribution.id}"', size=1)
    # Bypass the activation filter — visibility was already checked above.
    body["query"]["bool"]["filter"] = [
        f
        for f in body["query"]["bool"]["filter"]
        if "summary.contribution._is_activated" not in str(f)
        and "summary.contribution._is_latest" not in str(f)
    ]
    try:
        response = await get_opensearch().search(index=node.search.index, body=body)
        hits = response["hits"]["hits"]
    except NotFoundError:
        hits = []
    if hits:
        return hits[0]["_source"]
    raise HTTPException(404, f"contribution {contribution_id} is not indexed yet")


@router.get("/contributions/{contribution_id}/download")
async def download_contribution(
    session: SessionDep, node: NodeDep, contribution_id: int, private_key: str | None = None
) -> Response:
    contribution = await _get_visible_contribution(session, node, contribution_id, private_key)
    if not contribution.filename:
        raise HTTPException(404, "this contribution has no file")
    data = await load_file(node, contribution.id, contribution.filename)
    return Response(
        content=data,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{contribution.filename}"'},
    )
