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
        # Cell values are arbitrary strings; a value that merely looks like a
        # date (e.g. time_zero "1/1/70") must not be auto-typed as `date` — a
        # later non-conforming value would then fail to index. Keep everything
        # a string; the one field we sort on (contribution timestamp) is typed
        # explicitly below.
        "date_detection": False,
        "numeric_detection": False,
        "dynamic_templates": [
            {
                # Number columns' values (summary._num.<column>, see
                # fiesta.domain.summarize): always double, so a column whose
                # first value is a whole number is not mapped as a long.
                "numbers": {
                    "path_match": "summary._num.*",
                    "mapping": {"type": "double"},
                }
            },
            {
                # The columns with data per table (summary._has.<table>, see
                # fiesta.domain.summarize): exact names, for the with/without
                # data filter's terms clauses and per-column counts.
                "column_names": {
                    "path_match": "summary._has.*",
                    "mapping": {"type": "keyword"},
                }
            },
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
                # Geometry a plugin computes for the UI to draw (e.g. a pole's
                # uncertainty ring): kept in _source, never indexed or searched.
                "unindexed_geometry": {
                    "match": "_geometry",
                    "match_mapping_type": "object",
                    "mapping": {"type": "object", "enabled": False},
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
            "summary": {
                "properties": {
                    "contribution": {
                        "properties": {
                            # Explicit date so search sort works; the seeder and
                            # workflow always write an ISO 8601 timestamp here.
                            "timestamp": {
                                "type": "date",
                                "format": "strict_date_optional_time||epoch_millis",
                                "ignore_malformed": True,
                            },
                        }
                    }
                }
            },
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
