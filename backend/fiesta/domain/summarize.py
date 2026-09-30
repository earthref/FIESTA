"""Summarization: explode one contribution into denormalized search documents.

For a node with hierarchy [contribution, A, B, ...] this produces:

- one `contribution` doc: the contribution row, per-level `_n_results`
  counts, and a cross-level `summary._all` union of facetable values and
  every distinct `_geo_point` of its rows (capped), so a geospatial filter
  matches it when any part of it is inside;
- one doc per named record of each hierarchy level below `contribution` (as
  the legacy docs): a level's rows sharing a name (its key column, "site" for
  sites) are one doc, with the shared `summary.contribution` block, the rows
  merged under `summary.<level>` (each column's first value) plus
  `_n_results` (how many rows, the level's `count_field`), the raw rows in
  `rows`, and per-doc `_all` values, including its `_geo_point`: its rows'
  own coordinates or, without any, its nearest ancestor's (a specimen's
  sample's, found by the `sample` column), so every level narrows under the
  same filter. A row without a name is a doc of its own.

Positions on another planetary body (a lunar location and the rows below
it, by the node's `search.bodies`) are `_body_point` ({lat, lon, body})
instead of `_geo_point`, on the contribution doc too.

This is a deliberate simplification of the legacy
`summarize_contribution.js` adopt/inherit/aggregate pipeline: enough for
search, facets, counts, geolocation, and downloads. Deeper rollups (age
ranges, poles, method-code inheritance across levels) can be layered on
without changing the document contract.
"""

from typing import Any

from fiesta.domain.data_model import LIST_TYPES, column_values, split_list
from fiesta.domain.parse import ID_COLUMNS, ParsedContribution
from fiesta.nodeconfig import BOX_COLUMNS, LAT_COLUMNS, LON_COLUMNS, NodeConfig

# Columns whose (colon-delimited) values feed summary._all facets when present.
FACETABLE_COLUMNS = {
    "method_codes",
    "geologic_classes",
    "geologic_types",
    "lithologies",
    "location_type",
    "plate_blocks",
    "tectonic_settings",
    "citations",
}


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _wrap(lon: float) -> float:
    return ((lon + 180) % 360) - 180


def _geo_point(row: dict) -> dict | None:
    """A row's position: its lat/lon, or the middle of its box (lat_s/lat_n,
    lon_w/lon_e, which may cross the antimeridian)."""
    box = [_to_float(row.get(c)) for c in BOX_COLUMNS]
    if row.get("lat") in (None, "") and all(v is not None for v in box):
        west, south, east, north = box
        west, east = _wrap(west), _wrap(east)
        if west > east:
            east += 360
        lat, lon = (south + north) / 2, (west + east) / 2
    else:
        lat = next((v for c in LAT_COLUMNS if (v := _to_float(row.get(c))) is not None), None)
        lon = next((v for c in LON_COLUMNS if (v := _to_float(row.get(c))) is not None), None)
    if lat is None or lon is None or not (-90 <= lat <= 90):
        return None
    return {"lat": lat, "lon": _wrap(lon)}


# Distinct positions on the contribution doc (enough to match an area anywhere
# in a large study while keeping the doc bounded).
MAX_GEO_POINTS = 500


# Distinct-values cap per column in summary._all (keeps huge contributions'
# roll-up docs bounded; facets and free-text search degrade gracefully).
MAX_ALL_VALUES = 500


def _collect_all(columns_def: dict, rows: list[dict], into: dict[str, set]) -> None:
    """Union row values per column — the cross-level `summary._all` roll-up
    that powers free-text search and facets on parent-level docs."""
    for row in rows:
        for column, value in row.items():
            if value in (None, "") or column in ID_COLUMNS:
                continue
            column_def = columns_def.get(column, {})
            if column in FACETABLE_COLUMNS or column_def.get("type") in LIST_TYPES:
                values = column_values(column_def, value) or split_list(value)
            else:
                values = [str(value)]
            bucket = into.setdefault(column, set())
            if len(bucket) < MAX_ALL_VALUES:
                bucket.update(values)


def _finalize_all(
    collected: dict[str, set], geo_point: dict | list | None, body_point: list | None = None
) -> dict:
    result: dict[str, Any] = {k: sorted(v) for k, v in collected.items() if v}
    if geo_point:
        result["_geo_point"] = geo_point
    if body_point:
        result["_body_point"] = body_point
    return result


def placed(point: dict, body: str | None) -> dict:
    """A position's `summary._all` entry: `_geo_point` on Earth, or on another
    body `_body_point` with its name (kept out of the geo_point field, which
    Earth's area filters and map aggregations read)."""
    return {"_geo_point": point} if body is None else {"_body_point": {**point, "body": body}}


def _row_body(
    node: NodeConfig,
    row: dict,
    ancestors: list[tuple[str, str]],
    found: dict[str, dict[str, str]],
) -> str | None:
    config = node.search.bodies
    if config is None:
        return None
    return config.body_of(row) or next(
        (
            body
            for ancestor, key in ancestors
            if (body := found.get(ancestor, {}).get(str(row.get(key) or "")))
        ),
        None,
    )


def planetary_bodies(node: NodeConfig, parsed: ParsedContribution) -> dict[str, dict[str, str]]:
    """The named rows of each level that are on another planetary body
    ({"sites": {"S1": "moon"}}): those whose `search.bodies` column names one,
    and those below them (by their ancestors' key columns)."""
    found: dict[str, dict[str, str]] = {}
    if node.search.bodies is None:
        return found
    levels = node.hierarchy[1:]
    for index, level in enumerate(levels):
        ancestors = [(a, a.removesuffix("s")) for a in reversed(levels[:index])]
        for row in parsed.tables.get(level, []):
            name = row.get(level.removesuffix("s"))
            if name not in (None, "") and (body := _row_body(node, row, ancestors, found)):
                found.setdefault(level, {}).setdefault(str(name), body)
    return found


def group_rows(rows: list[dict], key: str) -> list[list[dict]]:
    """A level's rows as records: those sharing a `key` value together, in the
    order each name first appears; a row without one on its own."""
    groups: dict[str, list[dict]] = {}
    ordered: list[list[dict]] = []
    for row in rows:
        name = row.get(key)
        if name in (None, ""):
            ordered.append([row])
            continue
        group = groups.get(str(name))
        if group is None:
            group = groups[str(name)] = []
            ordered.append(group)
        group.append(row)
    return ordered


def merge_rows(rows: list[dict]) -> dict:
    """A record's rows as one: each column's first value."""
    merged: dict[str, Any] = {}
    for row in rows:
        for column, value in row.items():
            if value not in (None, "") and merged.get(column) in (None, ""):
                merged[column] = value
            else:
                merged.setdefault(column, value)
    return merged


def summarize(
    node: NodeConfig,
    parsed: ParsedContribution,
    contribution_meta: dict,
) -> list[dict]:
    """Build the search docs for one contribution.

    `contribution_meta` carries the workflow fields (id, version, timestamps,
    _contributor, _contributor_id, _private_key, _is_activated, _is_latest,
    _reference, ...) merged into `summary.contribution` on every doc.
    """
    model = node.load_data_model(node.data_model.latest)
    hierarchy = node.hierarchy

    contribution_rows = parsed.tables.get("contribution", [])
    contribution_summary: dict[str, Any] = dict(contribution_rows[0]) if contribution_rows else {}
    contribution_summary.update(contribution_meta)

    docs: list[dict] = []
    all_values: dict[str, set] = {}
    level_counts: dict[str, dict] = {}
    # Every level's positions by row name ({"samples": {"S1-a": point}}), for
    # the rows below it that have none of their own; and the contribution's.
    positions: dict[str, dict[str, dict]] = {}
    # By (body, lat, lon), with Earth's body None.
    points: dict[tuple[str | None, float, float], dict] = {}
    bodies = planetary_bodies(node, parsed)
    levels = hierarchy[1:]

    for index, level in enumerate(levels):
        rows = parsed.tables.get(level, [])
        level_counts[level] = {"_n_results": len(rows)}
        columns_def = model["tables"].get(level, {}).get("columns", {})
        _collect_all(columns_def, rows, all_values)
        # A row names its ancestors by their key columns ("sites" -> "site").
        ancestors = [(a, a.removesuffix("s")) for a in reversed(levels[:index])]

        for group in group_rows(rows, level.removesuffix("s")):
            merged = merge_rows(group)
            name = merged.get(level.removesuffix("s"))
            body = (
                bodies.get(level, {}).get(str(name))
                if name not in (None, "")
                else _row_body(node, merged, ancestors, bodies)
            )
            row_all: dict[str, set] = {}
            _collect_all(columns_def, group, row_all)
            geo = None
            for row in group:
                own = _geo_point(row)
                if own is not None and len(points) < MAX_GEO_POINTS:
                    points.setdefault((body, round(own["lat"], 4), round(own["lon"], 4)), own)
                geo = geo or own
            if geo is None:
                geo = next(
                    (
                        found
                        for ancestor, key in ancestors
                        if (found := positions.get(ancestor, {}).get(str(merged.get(key) or "")))
                    ),
                    None,
                )
            if geo is not None and name not in (None, ""):
                positions.setdefault(level, {}).setdefault(str(name), geo)
            docs.append(
                {
                    "type": level,
                    "summary": {
                        "contribution": contribution_summary,
                        level: {**merged, "_n_results": len(group)},
                        "_all": {
                            **_finalize_all(row_all, None),
                            **(placed(geo, body) if geo else {}),
                        },
                    },
                    "rows": group,
                }
            )

    contribution_doc = {
        "type": "contribution",
        "summary": {
            "contribution": contribution_summary,
            "_all": _finalize_all(
                all_values,
                [p for (body, *_), p in points.items() if body is None] or None,
                [{**p, "body": body} for (body, *_), p in points.items() if body is not None],
            ),
            **level_counts,
        },
    }
    return [contribution_doc, *docs]


def doc_id(contribution_id: int, doc_type: str, ordinal: int) -> str:
    return f"{contribution_id}-{doc_type}-{ordinal}"
