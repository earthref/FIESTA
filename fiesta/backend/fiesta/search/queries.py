"""Query construction for node search.

Supports the legacy search-box grammar: free text plus field-scoped tokens
like `id:"12345"`, `doi:"10.1029/..."`, `private_key:"<uuid>"`, and
`<field>:"<value>"` (matched against summary._all.<field>.raw). Multi-values
split on `||`. A value with a `*` is a wildcard, matched ignoring case
(`site_name:"*kenya*"`: a name containing "kenya"), and `radius:"<lat>,<lon>,<km>"`
matches docs with a position within that great-circle distance of the
centre (`summary._all._geo_point`).

Every query is filtered to `_is_latest`; `_is_activated` is required unless a
private_key token is present (which unlocks exactly that private
contribution).
"""

import math
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
# The contribution-block terms a facet filter can be on (every node's
# Contribution ID and Contributor filters); never the private key.
CONTRIBUTION_FACETS = {"id", "contributor", "doi", "orcid"}
# Search doc fields no search response returns.
PRIVATE_SOURCE = ["summary.contribution._private_key"]
# Date fields: a range filter's bounds and histogram are epoch milliseconds.
DATE_FIELDS = {"summary.contribution.timestamp"}


def facet_path(field: str) -> str:
    """A facet's keyword field: a contribution-block term's, else the doc's
    `_all` roll-up of that column."""
    if field in CONTRIBUTION_FACETS:
        return CONTRIBUTION_TERMS[field]
    return f"summary._all.{field}.raw"


# Free text searches the contribution block and each doc's `_all` roll-up
# (which already unions the doc's own level values), never every field: the
# per-level summaries and `_num` push an index past OpenSearch's 1,024-field
# expansion limit, and an unscoped query then fails for every search box.
TEXT_FIELDS = ["summary.contribution.*", "summary._all.*"]

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


HAS_FIELD = "summary._has"

# The `radius:"<lat>,<lon>,<km>"` token: positions within that great-circle
# distance (OpenSearch's arc distance) of the centre; at most half way round.
RADIUS_TOKEN = "radius"
EARTH_RADIUS_KM = 6371.0
MAX_RADIUS_KM = math.pi * EARTH_RADIUS_KM


def radius_clause(value: str) -> dict:
    """A `radius` token value as a geo_distance clause; a malformed one (or a
    centre off the globe) matches nothing rather than everything."""
    try:
        lat, lon, km = (float(part) for part in value.split(","))
    except ValueError:
        return {"match_none": {}}
    if not (-90 <= lat <= 90 and -360 <= lon <= 360 and km >= 0):
        return {"match_none": {}}
    lon = (lon + 180) % 360 - 180
    return {
        "geo_distance": {
            "distance": f"{min(km, MAX_RADIUS_KM)}km",
            "summary._all._geo_point": {"lat": lat, "lon": lon},
        }
    }


def token_clause(field: str, values: list[str]) -> dict:
    """A field token's values, OR'd: exact terms, `*` wildcards ignoring case
    (a column's keyword field; never a contribution-block term, so never a
    private key), and for `radius` circles around a centre."""
    if field == RADIUS_TOKEN:
        clauses = [radius_clause(value) for value in values]
    elif field in CONTRIBUTION_TERMS:
        clauses = [{"terms": {CONTRIBUTION_TERMS[field]: values}}]
    else:
        path = f"summary._all.{field}.raw"
        exact = [value for value in values if "*" not in value]
        clauses = [{"terms": {path: exact}}] if exact else []
        clauses += [
            {"wildcard": {path: {"value": value, "case_insensitive": True}}}
            for value in values
            if "*" in value
        ]
    if len(clauses) == 1:
        return clauses[0]
    return {"bool": {"should": clauses, "minimum_should_match": 1}}


def has_clauses(has: list[dict] | None) -> list[dict]:
    """The with/without data filter's clauses (`summary._has.<table>`, see
    fiesta.domain.summarize), for {table, column, without} entries: those of
    one table and sense are one filter whose columns are OR'd, separate
    filters AND. With: a value in any of the columns. Without: the doc has
    the table but not all of the columns (lacks at least one)."""
    groups: dict[tuple[str, bool], list[str]] = {}
    for entry in has or []:
        columns = groups.setdefault((entry["table"], bool(entry["without"])), [])
        if entry["column"] not in columns:
            columns.append(entry["column"])
    clauses: list[dict] = []
    for (table, without), columns in groups.items():
        field = f"{HAS_FIELD}.{table}"
        if not without:
            clauses.append({"terms": {field: columns}})
            continue
        every = {"bool": {"filter": [{"term": {field: column}} for column in columns]}}
        clauses.append({"bool": {"filter": [{"exists": {"field": field}}], "must_not": [every]}})
    return clauses


def build_search_body(
    *,
    table: str,
    query: str | None,
    size: int = 10,
    from_: int = 0,
    facets: list[str] | None = None,
    facet_size: int = 100,
    count_field: str | None = None,
    contributor_id: int | None = None,
    private_only: bool = False,
    ranges: list[dict] | None = None,
    bbox: tuple[float, float, float, float] | None = None,
    sort: str | list | None = None,
    column_filters: list[dict] | None = None,
    has: list[dict] | None = None,
) -> dict[str, Any]:
    """`sort` is a SORT_OPTIONS key or a list of sort clauses (a grid column
    header's); None picks relevance when there is free text and newest-first
    otherwise (the legacy page's default behaviour). `column_filters` are
    extra filter clauses (the grid's column filters); `has` the with/without
    data filter's entries (see has_clauses)."""
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
        filters.append(token_clause(field, values))

    for range_filter in ranges or []:
        field = range_filter.get("field", "")
        if not field.startswith("summary."):
            continue
        bounds = {op: range_filter[op] for op in ("gte", "lte") if range_filter.get(op) is not None}
        if field in DATE_FIELDS:
            # Whole epoch milliseconds (the date format's epoch_millis).
            bounds = {op: int(value) for op, value in bounds.items()}
        if bounds:
            filters.append({"range": {field: bounds}})

    filters.extend(column_filters or [])
    filters.extend(has_clauses(has))

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
                    "fields": TEXT_FIELDS,
                    "default_operator": "and",
                    "lenient": True,
                }
            }
        )

    body: dict[str, Any] = {
        "size": size,
        "from": from_,
        # A doc's private key is indexed (a `private_key:` token matches it)
        # but never returned: only its owner or an admin may see it (the
        # private workspace API). A caller listing `_source` fields replaces this.
        "_source": {"excludes": PRIVATE_SOURCE},
        # Exact totals: the level tabs count past OpenSearch's default 10,000.
        "track_total_hits": True,
        "query": {"bool": {"filter": filters, "must": must}},
        "sort": sort
        if isinstance(sort, list)
        else SORT_OPTIONS[sort or ("relevance" if text else DEFAULT_SORT)],
    }

    if facets:
        aggs: dict[str, Any] = {}
        for facet in facets:
            agg: dict[str, Any] = {"terms": {"field": facet_path(facet), "size": facet_size}}
            if count_field:
                # Each value's rows, for the Data sub-tab (a doc without the
                # count field is one row, as in the router's `_n_rows`).
                agg["aggs"] = {"count": {"sum": {"field": count_field, "missing": 1}}}
            aggs[facet] = agg
        body["aggs"] = aggs

    return body
