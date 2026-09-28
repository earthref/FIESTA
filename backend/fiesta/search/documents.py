"""Indexing contribution documents into the node index."""

from opensearchpy import AsyncOpenSearch
from opensearchpy.helpers import async_bulk

from fiesta.domain.summarize import doc_id


async def index_contribution_docs(
    client: AsyncOpenSearch, index: str, contribution_id: int, docs: list[dict]
) -> None:
    await delete_contribution_docs(client, index, contribution_id)
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
