"""Index management.

One OpenSearch index per node (name from the deployment YAML). Documents are
denormalized: for each contribution there is one doc per hierarchy level
(`type` field), each carrying the shared `summary.contribution` block, its own
level summary, cross-level `summary._all` aggregates, and (for row-level
types) the raw table rows.

Mappings follow the legacy convention: every string is indexed as text with a
`.raw` keyword subfield used for terms facets and exact filters.
"""

from opensearchpy import AsyncOpenSearch
from opensearchpy.exceptions import RequestError

INDEX_BODY = {
    "settings": {
        "index": {
            "number_of_shards": 1,
            "number_of_replicas": 0,
            "mapping": {"total_fields": {"limit": 10000}},
        }
    },
    "mappings": {
        "dynamic_templates": [
            {
                "geo_points": {
                    "match": "_geo_point",
                    "mapping": {"type": "geo_point"},
                }
            },
            {
                "geo_shapes": {
                    "match": "_geo_envelope",
                    "mapping": {"type": "geo_shape"},
                }
            },
            {
                "strings_with_raw": {
                    "match_mapping_type": "string",
                    "mapping": {
                        "type": "text",
                        "fields": {"raw": {"type": "keyword", "ignore_above": 1024}},
                    },
                }
            },
        ],
        "properties": {
            "type": {"type": "keyword"},
            "rows": {"type": "object", "enabled": False},
        },
    },
}


async def ensure_index(client: AsyncOpenSearch, index: str) -> None:
    if not await client.indices.exists(index=index):
        try:
            await client.indices.create(index=index, body=INDEX_BODY)
        except RequestError as exc:
            # Concurrent service start-ups race to create the index.
            if exc.error != "resource_already_exists_exception":
                raise


async def recreate_index(client: AsyncOpenSearch, index: str) -> None:
    if await client.indices.exists(index=index):
        await client.indices.delete(index=index)
    await client.indices.create(index=index, body=INDEX_BODY)
