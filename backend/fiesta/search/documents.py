"""Indexing contribution documents into the node index."""

import logging

from opensearchpy import AsyncOpenSearch, TransportError
from opensearchpy.helpers import async_bulk

from fiesta.domain.summarize import doc_id

logger = logging.getLogger(__name__)

# A contribution's doc ids come from one search up to this many docs (the
# index's max_result_window); past it they are scrolled.
IDS_PAGE = 10_000


async def contribution_doc_ids(
    client: AsyncOpenSearch, index: str, contribution_id: int
) -> set[str]:
    """A contribution's doc ids in an index: one search, or a scroll past
    IDS_PAGE docs whose context is cleared best effort (the production
    `fiesta` role may not clear a scroll, indices:data/read/scroll/clear, and
    the context expires in 1m anyway)."""
    body = {
        "query": {"term": {"summary.contribution.id": contribution_id}},
        "_source": False,
        "size": IDS_PAGE,
        "track_total_hits": True,
    }
    hits = (await client.search(index=index, body=body))["hits"]
    total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]
    if total <= len(hits["hits"]):
        return {hit["_id"] for hit in hits["hits"]}
    ids: set[str] = set()
    response = await client.search(index=index, body={**body, "sort": ["_doc"]}, scroll="1m")
    scroll_id = response.get("_scroll_id")
    try:
        while response["hits"]["hits"]:
            ids.update(hit["_id"] for hit in response["hits"]["hits"])
            response = await client.scroll(scroll_id=scroll_id, scroll="1m")
            scroll_id = response.get("_scroll_id", scroll_id)
    finally:
        if scroll_id:
            try:
                await client.clear_scroll(scroll_id=scroll_id, ignore=(404,))
            except TransportError as exc:
                logger.warning("could not clear the doc id scroll: %s", exc)
    return ids


async def index_contribution_docs(
    client: AsyncOpenSearch,
    index: str,
    contribution_id: int,
    docs: list[dict],
    prune: bool = True,
) -> None:
    """Write a contribution's docs, then delete only its stale ones, by id.

    Doc ids are deterministic, so a write replaces a doc in place. Stale docs (a
    record the new revision no longer has) go after the write, never by a
    delete-by-query before it: on a loaded cluster a delete-by-query can time
    out here yet still run on the server after a retry has re-indexed, leaving
    the contribution `indexed` in Postgres but missing from search. Without
    `prune` (an index being rebuilt, which has no older docs) nothing is
    looked up or deleted."""
    counters: dict[str, int] = {}
    actions = []
    for doc in docs:
        ordinal = counters.get(doc["type"], 0)
        counters[doc["type"]] = ordinal + 1
        actions.append(
            {
                "_op_type": "index",
                "_index": index,
                "_id": doc_id(contribution_id, doc["type"], ordinal),
                "_source": doc,
            }
        )
    if actions:
        await async_bulk(client, actions, chunk_size=500)
    if not prune:
        return
    current = {action["_id"] for action in actions}
    stale = sorted(await contribution_doc_ids(client, index, contribution_id) - current)
    if stale:
        await async_bulk(
            client,
            ({"_op_type": "delete", "_index": index, "_id": i} for i in stale),
            chunk_size=500,
            ignore_status=(404,),
        )
    await client.indices.refresh(index=index)


async def delete_contribution_docs(
    client: AsyncOpenSearch, index: str, contribution_id: int
) -> None:
    await client.delete_by_query(
        index=index,
        body={"query": {"term": {"summary.contribution.id": contribution_id}}},
        conflicts="proceed",
        refresh=True,
    )


async def update_contribution_flags(
    client: AsyncOpenSearch, index: str, contribution_id: int, flags: dict
) -> None:
    """Update workflow flags (_is_activated, _is_latest, ...) on every doc of
    a contribution without re-summarizing."""
    script_lines = [
        f"ctx._source.summary.contribution['{key}'] = params['{key}'];" for key in flags
    ]
    await client.update_by_query(
        index=index,
        body={
            "query": {"term": {"summary.contribution.id": contribution_id}},
            "script": {"source": " ".join(script_lines), "params": flags, "lang": "painless"},
        },
        conflicts="proceed",
        refresh=True,
    )


async def set_contribution_reference(
    client: AsyncOpenSearch, index: str, contribution_id: int, reference: dict
) -> None:
    """Set `summary.contribution._reference` (publication metadata) on every
    doc of a contribution without re-summarizing."""
    response = await client.update_by_query(
        index=index,
        body={
            "query": {"term": {"summary.contribution.id": contribution_id}},
            "script": {
                "source": "ctx._source.summary.contribution._reference = params.reference;",
                "params": {"reference": reference},
                "lang": "painless",
            },
        },
        conflicts="proceed",
        refresh=True,
    )
    if response.get("failures"):
        raise RuntimeError(f"update_by_query failed: {response['failures'][:1]}")
