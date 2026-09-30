"""Indexing contribution documents into the node index."""

from opensearchpy import AsyncOpenSearch
from opensearchpy.helpers import async_bulk, async_scan

from fiesta.domain.summarize import doc_id


async def index_contribution_docs(
    client: AsyncOpenSearch, index: str, contribution_id: int, docs: list[dict]
) -> None:
    """Write a contribution's docs, then delete only its stale ones, by id.

    Doc ids are deterministic, so a write replaces a doc in place. Stale docs (a
    record the new revision no longer has) go after the write, never by a
    delete-by-query before it: on a loaded cluster a delete-by-query can time
    out here yet still run on the server after a retry has re-indexed, leaving
    the contribution `indexed` in Postgres but missing from search."""
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
    current = {action["_id"] for action in actions}
    stale = [
        hit["_id"]
        async for hit in async_scan(
            client,
            index=index,
            query={"query": {"term": {"summary.contribution.id": contribution_id}}},
            _source=False,
        )
        if hit["_id"] not in current
    ]
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
