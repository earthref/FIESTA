"""Query construction for node search.

Supports the legacy search-box grammar: free text plus field-scoped tokens
like `id:"12345"`, `doi:"10.1029/..."`, `private_key:"<uuid>"`, and
`<field>:"<value>"` (matched against summary._all.<field>.raw). Multi-values
split on `||`.

Every query is filtered to `_is_latest`; `_is_activated` is required unless a
private_key token is present (which unlocks exactly that private
contribution).
"""

import re
from typing import Any

TOKEN_RE = re.compile(r'(\w+):"([^"]*)"')

# Tokens that map to summary.contribution.* instead of summary._all.*
CONTRIBUTION_TERMS = {
    "id": "summary.contribution.id",
    "private_key": "summary.contribution._private_key.raw",
    "doi": "summary.contribution._reference.doi.raw",
    "contributor": "summary.contribution._contributor.raw",
    "orcid": "summary.contribution._reference.authors._orcid.raw",
}

_TIMESTAMP = "summary.contribution.timestamp"
_REFERENCE = "summary.contribution._reference"


def _sort_clause(field: str, order: str, unmapped_type: str) -> dict:
    # `unmapped_type` keeps a sort valid on an index (or node) that never
    # indexed the field, e.g. a node without Crossref reference metadata.
    return {field: {"order": order, "unmapped_type": unmapped_type}}


# Named sort options (the legacy search page's sort dropdown). Every option is
# a list of OpenSearch sort clauses; ties always fall back to newest first.
SORT_OPTIONS: dict[str, list] = {
    "relevance": ["_score", _sort_clause(_TIMESTAMP, "desc", "date")],
    "recent": [_sort_clause(_TIMESTAMP, "desc", "date")],
    "recent_asc": [_sort_clause(_TIMESTAMP, "asc", "date")],
    "published": [
        _sort_clause(f"{_REFERENCE}.year", "desc", "integer"),
        _sort_clause(_TIMESTAMP, "desc", "date"),
    ],
    "published_asc": [
        _sort_clause(f"{_REFERENCE}.year", "asc", "integer"),
        _sort_clause(_TIMESTAMP, "desc", "date"),
    ],
    "cited": [
        _sort_clause(f"{_REFERENCE}.n_citations", "desc", "integer"),
        _sort_clause(_TIMESTAMP, "desc", "date"),
    ],
    "citation_az": [
        _sort_clause(f"{_REFERENCE}.citation.raw", "asc", "keyword"),
        _sort_clause(_TIMESTAMP, "desc", "date"),
    ],
    "citation_za": [
        _sort_clause(f"{_REFERENCE}.citation.raw", "desc", "keyword"),
        _sort_clause(_TIMESTAMP, "desc", "date"),
    ],
    "id_desc": [_sort_clause("summary.contribution.id", "desc", "long")],
    "id_asc": [_sort_clause("summary.contribution.id", "asc", "long")],
}
DEFAULT_SORT = "recent"


def parse_query(query: str | None) -> tuple[str, dict[str, list[str]]]:
    """Split a search-box string into free text and field tokens."""
    tokens: dict[str, list[str]] = {}
    text = query or ""
    for match in TOKEN_RE.finditer(text):
        field, value = match.group(1), match.group(2)
        tokens.setdefault(field, []).extend(v.strip() for v in value.split("||") if v.strip())
    text = TOKEN_RE.sub("", text).strip()
    return text, tokens


def build_search_body(
    *,
    table: str,
    query: str | None,
    size: int = 10,
    from_: int = 0,
    facets: list[str] | None = None,
    count_field: str | None = None,
    contributor_id: int | None = None,
    private_only: bool = False,
    ranges: list[dict] | None = None,
    bbox: tuple[float, float, float, float] | None = None,
    sort: str | None = None,
) -> dict[str, Any]:
    """`sort` is a SORT_OPTIONS key; None picks relevance when there is free
    text and newest-first otherwise (the legacy page's default behaviour)."""
    text, tokens = parse_query(query)
    has_private_key = "private_key" in tokens

    filters: list[dict] = [
        {"term": {"type": table}},
        {"term": {"summary.contribution._is_latest": True}},
    ]
    must: list[dict] = []

    if private_only:
        # Caller's private workspace search.
        filters.append({"term": {"summary.contribution._is_activated": False}})
        if contributor_id is not None:
            filters.append({"term": {"summary.contribution._contributor_id": contributor_id}})
    elif not has_private_key:
        filters.append({"term": {"summary.contribution._is_activated": True}})

    for field, values in tokens.items():
        path = CONTRIBUTION_TERMS.get(field)
        if path is None:
            path = f"summary._all.{field}.raw"
        filters.append({"terms": {path: values}})

    for range_filter in ranges or []:
        field = range_filter.get("field", "")
        if not field.startswith("summary."):
            continue
        bounds = {
            op: range_filter[op] for op in ("gte", "lte") if range_filter.get(op) is not None
        }
        if bounds:
            filters.append({"range": {field: bounds}})

    if bbox is not None:
        min_lon, min_lat, max_lon, max_lat = bbox
        filters.append(
            {
                "geo_bounding_box": {
                    "summary._all._geo_point": {
                        "top_left": {"lat": max_lat, "lon": min_lon},
                        "bottom_right": {"lat": min_lat, "lon": max_lon},
                    }
                }
            }
        )

    if text:
        must.append(
            {
                "simple_query_string": {
                    "query": text,
                    "default_operator": "and",
                }
            }
        )

    body: dict[str, Any] = {
        "size": size,
        "from": from_,
        "query": {"bool": {"filter": filters, "must": must}},
        "sort": SORT_OPTIONS[sort or ("relevance" if text else DEFAULT_SORT)],
    }

    if facets:
        aggs: dict[str, Any] = {}
        for facet in facets:
            agg: dict[str, Any] = {
                "terms": {"field": f"summary._all.{facet}.raw", "size": 100}
            }
            if count_field:
                agg["aggs"] = {"count": {"sum": {"field": count_field}}}
            aggs[facet] = agg
        body["aggs"] = aggs

    return body
