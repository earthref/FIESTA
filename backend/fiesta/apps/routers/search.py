"""Public search + contribution retrieval for the node frontend."""

import logging
import math
import uuid as uuid_mod
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Response
from opensearchpy.exceptions import NotFoundError, TransportError

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.apps.schemas import MapPoints, SearchPage, SearchValues
from fiesta.db.models import Contribution
from fiesta.nodeconfig import BOX_COLUMNS, MapColor
from fiesta.search.client import get_opensearch
from fiesta.search.grid import filter_clause, level_columns, sort_clauses
from fiesta.search.queries import SORT_OPTIONS, build_search_body
from fiesta.services.access import constrain_search
from fiesta.services.contributions import load_file
from fiesta.services.history import row_stats, versions

logger = logging.getLogger(__name__)

router = APIRouter(tags=["search"])


def _all_levels(node) -> list:
    from fiesta.plugins import active_plugins

    levels = list(node.search.levels)
    for plugin in active_plugins(node):
        levels.extend(plugin.search_levels(node))
    return levels


def _level_tables(node) -> set[str]:
    from fiesta.plugins import active_plugins

    tables = {lvl.table for lvl in _all_levels(node)} | set(node.search.extra_types)
    for plugin in active_plugins(node):
        tables.update(plugin.search_tables(node))
    return tables


def _grid_columns(node, table: str) -> dict:
    level = next((lvl for lvl in _all_levels(node) if lvl.table == table), None)
    return {c.key: c for c in level_columns(node, level)} if level else {}


def _grid_sort(node, table: str, sort: str | None) -> str | list | None:
    """A named SORT_OPTIONS key, or `<column>:asc|desc` on a sortable grid
    column of the level (its header's sort)."""
    if sort is None or sort in SORT_OPTIONS:
        return sort
    key, _, order = sort.rpartition(":")
    column = _grid_columns(node, table).get(key)
    if column is None or column.sort is None or order not in ("asc", "desc"):
        raise HTTPException(
            422, f"sort must be one of {sorted(SORT_OPTIONS)} or <sortable column>:asc|desc"
        )
    return sort_clauses(column, order)


def _grid_filters(node, table: str, filters: list[str] | None) -> list[dict]:
    """`filter=<column>:<text>`: records matching the typed words in a
    filterable grid column's fields."""
    if not filters:
        return []
    columns = _grid_columns(node, table)
    clauses = []
    for spec in filters:
        key, sep, text = spec.partition(":")
        column = columns.get(key)
        if not sep or column is None or not column.filter_fields:
            raise HTTPException(422, f"filter must be <filterable column>:<text>, got {spec!r}")
        if clause := filter_clause(column, text):
            clauses.append(clause)
    return clauses


def _parse_ranges(ranges: list[str] | None) -> list[dict] | None:
    """`range=summary.poles.age:0.5:120` -> {field, gte, lte} (blank = open)."""
    if not ranges:
        return None
    parsed = []
    for spec in ranges:
        parts = spec.split(":")
        if len(parts) != 3:
            raise HTTPException(422, f"range must be field:gte:lte, got {spec!r}")
        field, gte, lte = parts

        def _num(s: str, spec: str = spec) -> float | None:
            if not s:
                return None
            try:
                return float(s)
            except ValueError:
                raise HTTPException(422, f"invalid number in range {spec!r}") from None

        parsed.append({"field": field, "gte": _num(gte), "lte": _num(lte)})
    return parsed


def _parse_bbox(bbox: str | None) -> tuple[float, float, float, float] | None:
    """`bbox=minLon,minLat,maxLon,maxLat`"""
    if not bbox:
        return None
    try:
        min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(422, "bbox must be minLon,minLat,maxLon,maxLat") from None
    return (min_lon, min_lat, max_lon, max_lat)


def _drop_workflow_filters(body: dict) -> None:
    """Remove the `_is_activated` / `_is_latest` filters build_search_body adds,
    for a contribution whose visibility was already checked."""
    body["query"]["bool"]["filter"] = [
        f
        for f in body["query"]["bool"]["filter"]
        if "summary.contribution._is_activated" not in str(f)
        and "summary.contribution._is_latest" not in str(f)
    ]


async def _constrain(
    session, node, body: dict, query: str | None, contribution: int | None, private_key: str | None
) -> None:
    """Scope a search to what the caller may see or, with `contribution`, to
    that one contribution: any version, public or opened by its private key
    (the contribution modal's level tabs and map)."""
    if contribution is None:
        await constrain_search(session, node, body, query=query)
        return
    await _get_visible_contribution(session, node, contribution, private_key)
    _drop_workflow_filters(body)
    body["query"]["bool"]["filter"].append({"term": {"summary.contribution.id": contribution}})


def _facet_bucket(bucket: dict) -> dict:
    """A facet value's docs, its rows (levels with a count_field) and, with
    `totals`, its positioned docs: the sidebar counts follow the sub-tab."""
    out = {"key": bucket["key"], "doc_count": bucket["doc_count"]}
    if "count" in bucket:
        # An index that has never held the count field sums to 0: one row each.
        out["rows_count"] = int(bucket["count"]["value"] or 0) or bucket["doc_count"]
    if "mapped" in bucket:
        out["mapped_count"] = bucket["mapped"]["doc_count"]
    return out


@router.get("/search/{table}", response_model=SearchPage)
async def search(
    session: SessionDep,
    node: NodeDep,
    table: str,
    query: str | None = None,
    size: int = Query(10, ge=1, le=1000),
    from_: int = Query(0, ge=0, alias="from"),
    facets: bool = False,
    range_: Annotated[list[str] | None, Query(alias="range")] = None,
    bbox: str | None = None,
    sort: str | None = None,
    filter_: Annotated[list[str] | None, Query(alias="filter")] = None,
    contribution: int | None = None,
    private_key: str | None = None,
    totals: bool = False,
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
        ranges=_parse_ranges(range_),
        bbox=_parse_bbox(bbox),
        sort=_grid_sort(node, table, sort),
        column_filters=_grid_filters(node, table, filter_),
    )
    await _constrain(session, node, body, query, contribution, private_key)
    if totals:
        # The result sub-tabs' counts: the matches' rows (a doc without a
        # count_field is one row) and those with a position.
        aggs = body.setdefault("aggs", {})
        if level and level.count_field:
            aggs["_n_rows"] = {"sum": {"field": level.count_field, "missing": 1}}
        if table in node.geo_tables:
            positioned = {"filter": POSITIONED}
            aggs["_n_mapped"] = positioned
            # And per facet value, so the sidebar counts follow the Map sub-tab.
            for name in node.search.facets if facets else []:
                aggs[name].setdefault("aggs", {})["mapped"] = positioned
    try:
        response = await get_opensearch().search(index=node.search_index, body=body)
    except NotFoundError:
        return SearchPage(total=0, results=[], aggregations={} if facets else None)
    hits = response["hits"]
    total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]
    found = dict(response.get("aggregations") or {})
    rows = found.pop("_n_rows", None)
    mapped = found.pop("_n_mapped", None)
    aggregations = None
    if facets:
        aggregations = {
            name: [_facet_bucket(b) for b in agg.get("buckets", [])] for name, agg in found.items()
        }
    return SearchPage(
        total=total,
        results=[h["_source"] for h in hits["hits"]],
        aggregations=aggregations,
        # An index that has never held the count field sums to 0: one row each.
        rows_total=(int(rows["value"] or 0) or total) if rows else None,
        mapped_total=mapped["doc_count"] if mapped else None,
    )


# The map plots every match up to this many; past it `truncated` is set.
MAX_MAP_POINTS = 50_000
MAP_PAGE_SIZE = 10_000
# Past this many matches, a level's map is its unique locations instead of its
# records: a composite aggregation of ~2.4 m geotiles (zoom 24) by
# contribution, each at its records' centroid with their count (on 300k sites
# at 30k locations, 3 s against 9 s to scroll the docs, and a tenth the size).
MAP_DOCS_LIMIT = 10_000
MAP_PRECISION = 24
GEO_FIELD = "summary._all._geo_point"
# Positions on another planetary body ({lat, lon, body}; see summarize.py).
BODY_FIELD = "summary._all._body_point"
# Docs with a position on any body.
POSITIONED = {
    "bool": {
        "should": [{"exists": {"field": GEO_FIELD}}, {"exists": {"field": BODY_FIELD}}],
        "minimum_should_match": 1,
    }
}


def _to_float(value: Any) -> float | None:
    if isinstance(value, list):
        value = value[0] if value else None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _get_path(source: dict, path: str) -> Any:
    for key in path.split("."):
        source = source.get(key) if isinstance(source, dict) else None
    return source


def _color_value(source: dict, table: str, color: MapColor) -> float | None:
    """A doc's number to color its marker by (see MapColor), or None."""
    value = _to_float(_get_path(source, color.path(table)))
    if value is None or not math.isfinite(value):
        return None
    if color.unit_column:
        unit = _get_path(source, f"summary.{table}.{color.unit_column}")
        unit = str(unit[0] if isinstance(unit, list) else unit).strip()
        factor = color.unit_factors.get(unit)
        return None if factor is None else value * factor + color.unit_offsets.get(unit, 0.0)
    return value


# A MapColor's value from a doc's doc values, for the aggregated map: the
# first of `params.fields` the doc has (a keyword `.raw` or a numeric field),
# parsed as a number, in the base unit by the factor and offset of its unit
# (`params.unit`), if any.
VALUE_SCRIPT = """
def v = null;
for (String f : params.fields) {
  if (doc.containsKey(f) && doc[f].size() > 0) { v = doc[f].value; break; }
}
if (v == null) return null;
double x;
if (v instanceof Number) { x = ((Number) v).doubleValue(); }
else {
  try { x = Double.parseDouble(v.toString().trim()); }
  catch (NumberFormatException e) { return null; }
}
if (Double.isNaN(x) || Double.isInfinite(x)) return null;
if (params.unit != null) {
  if (!doc.containsKey(params.unit) || doc[params.unit].size() == 0) return null;
  String unit = doc[params.unit].value.trim();
  def factor = params.factors.get(unit);
  if (factor == null) return null;
  x = x * factor + params.offsets.getOrDefault(unit, 0.0);
}
return x;
"""


async def _value_script(client, index: str, table: str, color: MapColor) -> dict:
    """The avg aggregation of a MapColor's values, reading each path's doc
    values: its `.raw` keyword when it is text, else the field itself."""
    paths = [color.path(table)]
    if color.unit_column:
        paths.append(f"summary.{table}.{color.unit_column}")
    try:
        found = await client.indices.get_field_mapping(
            index=index, fields=[f for p in paths for f in (p, f"{p}.raw")]
        )
    except NotFoundError:
        found = {}
    mapped: dict[str, str] = {}
    for mappings in found.values():
        for name, spec in (mappings.get("mappings") or {}).items():
            leaf = next(iter((spec.get("mapping") or {}).values()), {})
            mapped.setdefault(name, leaf.get("type", ""))

    def doc_field(path: str) -> str | None:
        if f"{path}.raw" in mapped:
            return f"{path}.raw"
        return path if mapped.get(path, "text") != "text" else None

    field = doc_field(paths[0])
    return {
        "avg": {
            "script": {
                "source": VALUE_SCRIPT,
                "params": {
                    "fields": [field] if field else [],
                    "unit": doc_field(paths[1]) if color.unit_column else None,
                    "factors": color.unit_factors,
                    "offsets": color.unit_offsets,
                },
            }
        }
    }


def _inside(lat: float, lon: float, bbox: tuple[float, float, float, float] | None) -> bool:
    """Whether a point is in a `bbox` (whose min longitude is east of its max
    when it crosses the antimeridian)."""
    if bbox is None:
        return True
    min_lon, min_lat, max_lon, max_lat = bbox
    in_lon = min_lon <= lon <= max_lon if min_lon <= max_lon else lon >= min_lon or lon <= max_lon
    return min_lat <= lat <= max_lat and in_lon


def _map_points(
    source: dict,
    table: str,
    bbox: tuple[float, float, float, float] | None = None,
    color: MapColor | None = None,
) -> list[dict]:
    """A doc's positions for the map: its `_geo_point` (a contribution's are
    all of its rows', and only those inside `bbox` are drawn) and, without a
    `bbox` (an area on Earth), its `_body_point`s with their `body`; the row's
    box when it has one, what to call it, and its `color` value."""
    summary = source.get("summary") or {}
    geo = (summary.get("_all") or {}).get("_geo_point") or []
    elsewhere = (summary.get("_all") or {}).get("_body_point") or []
    row = summary.get(table) or {}
    base: dict[str, Any] = {"id": (summary.get("contribution") or {}).get("id")}
    # A level row is named by its own key column ("sites" -> "site").
    name = row.get(table.removesuffix("s")) if table != "contribution" else None
    if name not in (None, ""):
        base["name"] = str(name[0] if isinstance(name, list) else name)
    box = [_to_float(row.get(c)) for c in BOX_COLUMNS]
    if all(v is not None for v in box):
        base["bounds"] = box
    if color is not None and (value := _color_value(source, table, color)) is not None:
        base["value"] = value
    points = []
    for entry in geo if isinstance(geo, list) else [geo]:
        lat, lon = _to_float(entry.get("lat")), _to_float(entry.get("lon"))
        if lat is not None and lon is not None and (len(geo) < 2 or _inside(lat, lon, bbox)):
            points.append({**base, "lat": lat, "lon": lon})
    if bbox is None:
        for entry in elsewhere if isinstance(elsewhere, list) else [elsewhere]:
            lat, lon = _to_float(entry.get("lat")), _to_float(entry.get("lon"))
            if lat is not None and lon is not None and entry.get("body"):
                points.append({**base, "lat": lat, "lon": lon, "body": entry["body"]})
    return points


def _has_boxes(node, table: str) -> bool:
    """Whether a table's rows can be boxes (lat_s/lat_n/lon_w/lon_e), which
    the map draws per record."""
    columns = node.load_data_model(node.data_model.latest)["tables"].get(table, {})
    return all(c in columns.get("columns", {}) for c in BOX_COLUMNS)


def _location_point(bucket: dict) -> dict | None:
    """One composite bucket (a location and a contribution) as a map point."""
    at = (bucket.get("at") or {}).get("location")
    if not at:
        return None
    point = {
        "id": bucket["key"]["contribution"],
        # ~1 m, which is all the map shows and a third of the payload.
        "lat": round(at["lat"], 5),
        "lon": round(at["lon"], 5),
        "count": bucket["doc_count"],
    }
    # The mean of its records' color values.
    if (value := (bucket.get("value") or {}).get("value")) is not None:
        point["value"] = value
    return point


async def _location_points(
    client, index: str, query: dict, value: dict | None = None
) -> tuple[list[dict], bool]:
    """The unique locations of a search's records, per contribution, paged
    through a composite aggregation (with the `value` aggregation of their
    color values); and whether MAX_MAP_POINTS cut it short."""
    points: list[dict] = []
    after = None
    while len(points) < MAX_MAP_POINTS:
        composite: dict[str, Any] = {
            "size": MAP_PAGE_SIZE,
            "sources": [
                {"tile": {"geotile_grid": {"field": GEO_FIELD, "precision": MAP_PRECISION}}},
                {"contribution": {"terms": {"field": "summary.contribution.id"}}},
            ],
        }
        if after:
            composite["after"] = after
        response = await client.search(
            index=index,
            body={
                "size": 0,
                "query": query,
                "aggs": {
                    "locations": {
                        "composite": composite,
                        # Exact, unlike the tile's centre (and not clamped to Web
                        # Mercator's ±85.05°).
                        "aggs": {
                            "at": {"geo_centroid": {"field": GEO_FIELD}},
                            **({"value": value} if value else {}),
                        },
                    }
                },
            },
        )
        locations = response["aggregations"]["locations"]
        points += [p for b in locations["buckets"] if (p := _location_point(b))]
        after = locations.get("after_key")
        if len(locations["buckets"]) < MAP_PAGE_SIZE or not after:
            return points, False
    return points[:MAX_MAP_POINTS], True


@router.get("/search/{table}/points", response_model=MapPoints, response_model_exclude_none=True)
async def search_points(
    session: SessionDep,
    node: NodeDep,
    table: str,
    query: str | None = None,
    range_: Annotated[list[str] | None, Query(alias="range")] = None,
    bbox: str | None = None,
    filter_: Annotated[list[str] | None, Query(alias="filter")] = None,
    contribution: int | None = None,
    private_key: str | None = None,
    color_by: str | None = None,
) -> MapPoints:
    """Every positioned doc matching a search, for the search page's map; past
    MAP_DOCS_LIMIT matches at a level of single points (not the contribution
    level, not boxes, not one contribution's modal), their unique locations
    with a `count` each instead. `color_by` (a node `map_colors` field) adds
    each point's `value`: the doc's number, or a location's records' mean."""
    if table not in node.geo_tables:
        raise HTTPException(404, f"search table {table!r} has no positions")
    color = node.map_color(table, color_by) if color_by else None
    if color_by and color is None:
        raise HTTPException(400, f"{color_by!r} is not a map color of {table!r}")
    area = _parse_bbox(bbox)
    body = build_search_body(
        table=table,
        query=query,
        size=MAP_PAGE_SIZE,
        ranges=_parse_ranges(range_),
        bbox=area,
        column_filters=_grid_filters(node, table, filter_),
    )
    await _constrain(session, node, body, query, contribution, private_key)
    body["query"]["bool"]["filter"].append(POSITIONED)
    body["_source"] = [
        GEO_FIELD,
        BODY_FIELD,
        "summary.contribution.id",
        f"summary.{table}.{table.removesuffix('s')}",
        *(f"summary.{table}.{c}" for c in BOX_COLUMNS),
    ]
    if color is not None:
        body["_source"].append(color.path(table))
        if color.unit_column:
            body["_source"].append(f"summary.{table}.{color.unit_column}")
    if contribution is None and table != "contribution" and not _has_boxes(node, table):
        client = get_opensearch()
        try:
            count = await client.count(index=node.search_index, body={"query": body["query"]})
        except NotFoundError:
            return MapPoints(total=0, points=[])
        if count["count"] > MAP_DOCS_LIMIT:
            value = color and await _value_script(client, node.search_index, table, color)
            points, truncated = await _location_points(
                client, node.search_index, body["query"], value
            )
            # The locations are Earth's (a geotile grid); the few records on
            # other bodies are plotted one by one.
            elsewhere = {
                **body,
                "query": {"bool": {"filter": [body["query"], {"exists": {"field": BODY_FIELD}}]}},
            }
            await _scroll(
                node,
                elsewhere,
                lambda source: points.extend(_map_points(source, table, area, color)),
                lambda: len(points) >= MAX_MAP_POINTS,
            )
            return MapPoints(
                total=count["count"], points=points[:MAX_MAP_POINTS], truncated=truncated
            )
    points: list[dict] = []
    total = await _scroll(
        node,
        body,
        lambda source: points.extend(_map_points(source, table, area, color)),
        lambda: len(points) >= MAX_MAP_POINTS,
    )
    return MapPoints(total=total, points=points[:MAX_MAP_POINTS], truncated=total > MAX_MAP_POINTS)


async def _scroll(node, body: dict, collect, full) -> int:
    """Pass every hit's `_source` of a search to `collect`, a page of
    MAP_PAGE_SIZE at a time, until there are none left or `full()`; returns
    the search's total."""
    body["size"] = MAP_PAGE_SIZE
    body["sort"] = ["_doc"]
    body.pop("from", None)
    client = get_opensearch()
    try:
        response = await client.search(index=node.search_index, body=body, scroll="1m")
    except NotFoundError:
        return 0
    hits = response["hits"]
    total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]
    scroll_id = response.get("_scroll_id")
    try:
        while hits["hits"] and not full():
            for hit in hits["hits"]:
                collect(hit["_source"])
            if len(hits["hits"]) < MAP_PAGE_SIZE:
                break
            response = await client.scroll(scroll_id=scroll_id, scroll="1m")
            scroll_id = response.get("_scroll_id", scroll_id)
            hits = response["hits"]
    finally:
        # Best effort: the production `fiesta` role may not clear scrolls
        # (indices:data/read/scroll/clear), and the context expires in 1m anyway.
        if scroll_id:
            try:
                await client.clear_scroll(scroll_id=scroll_id, ignore=(404,))
            except TransportError as exc:
                logger.warning("could not clear the search scroll: %s", exc)
    return total


# Rows of values a plot fetches at most; past it `truncated` is set.
MAX_VALUE_ROWS = 50_000


def _value_field(field: str) -> str:
    """A `values` field: a path in a doc's summary, never a private one."""
    parts = field.split(".")
    if len(parts) < 3 or parts[0] != "summary" or any(p.startswith("_private") for p in parts):
        raise HTTPException(422, f"field must be summary.<block>.<name>, got {field!r}")
    return field


def _get_path(source: dict, field: str) -> Any:
    value: Any = source
    for part in field.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    if isinstance(value, list):
        value = value[0] if value else None
    return value if isinstance(value, (int, float, str)) else None


@router.get("/search/{table}/values", response_model=SearchValues)
async def search_values(
    session: SessionDep,
    node: NodeDep,
    table: str,
    field: Annotated[list[str], Query(min_length=1, max_length=50)],
    query: str | None = None,
    range_: Annotated[list[str] | None, Query(alias="range")] = None,
    bbox: str | None = None,
    contribution: int | None = None,
    private_key: str | None = None,
) -> SearchValues:
    """Some summary fields of every doc matching a search, as rows of values
    (one per doc, in `field` order), for plots of many docs."""
    if table not in _level_tables(node):
        raise HTTPException(404, f"unknown search table {table!r}")
    fields = [_value_field(f) for f in field]
    body = build_search_body(
        table=table,
        query=query,
        size=MAP_PAGE_SIZE,
        ranges=_parse_ranges(range_),
        bbox=_parse_bbox(bbox),
    )
    await _constrain(session, node, body, query, contribution, private_key)
    body["_source"] = fields
    rows: list[list] = []
    total = await _scroll(
        node,
        body,
        lambda source: rows.append([_get_path(source, f) for f in fields]),
        lambda: len(rows) >= MAX_VALUE_ROWS,
    )
    return SearchValues(
        total=total, fields=fields, rows=rows[:MAX_VALUE_ROWS], truncated=total > MAX_VALUE_ROWS
    )


async def _get_visible_contribution(
    session, node, contribution_id: int, private_key: str | None
) -> Contribution:
    contribution = await session.get(Contribution, contribution_id)
    if (
        contribution is None
        or contribution.deleted_at is not None
        or contribution.node != node.node.slug
    ):
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
    _drop_workflow_filters(body)
    try:
        response = await get_opensearch().search(index=node.search_index, body=body)
        hits = response["hits"]["hits"]
    except NotFoundError:
        hits = []
    if hits:
        return hits[0]["_source"]
    raise HTTPException(404, f"contribution {contribution_id} is not indexed yet")


@router.get("/contributions/{contribution_id}/versions")
async def get_versions(
    session: SessionDep, node: NodeDep, contribution_id: int, private_key: str | None = None
) -> list[dict]:
    """The contribution's version chain (previous_id), oldest first: every
    published version, plus this one."""
    contribution = await _get_visible_contribution(session, node, contribution_id, private_key)
    return await versions(session, contribution)


@router.get("/contributions/{contribution_id}/rows")
async def get_row_stats(
    session: SessionDep, node: NodeDep, contribution_id: int, private_key: str | None = None
) -> dict:
    """Per table, the rows the current revision's validation flagged and the
    rows that differ from the previous published version."""
    contribution = await _get_visible_contribution(session, node, contribution_id, private_key)
    return await row_stats(session, node, contribution)


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
