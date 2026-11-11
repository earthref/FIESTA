"""Summarization: explode one contribution into denormalized search documents.

For a node with hierarchy [contribution, A, B, ...] this produces:

- one `contribution` doc: the contribution row, per-level `_n_results`
  counts, and a cross-level `summary._all` union of facetable values and
  every distinct `_geo_point` of its records (capped), so a geospatial filter
  matches it when any part of it is inside;
- one doc per named record of each hierarchy level below `contribution` (as
  the legacy docs): a level's rows sharing a name (its key column, "site" for
  sites) are one doc, with the shared `summary.contribution` block, the rows
  merged under `summary.<level>` (each column's first value) plus
  `_n_results` (how many rows, the level's `count_field`), the raw rows in
  `rows`, and per-doc `_all` values (with the geography, INHERITED_COLUMNS,
  of the records above it that it names), including its `_geo_point`: every
  distinct lat/lon of its rows and, for an area (a table with a box), of the
  rows below it that name it (a location's sites' and samples'), one point
  or a list (capped); without any, its box's centre or its nearest
  ancestor's position (a specimen's sample's, found by the `sample` column),
  so every level narrows under the same filter. A row without a name is a
  doc of its own.

Every doc also has `summary._num`: per data-model number column (Number,
Integer) the sorted distinct values of its rows as numbers (the
contribution's: every level's), capped at MAX_ALL_VALUES but always keeping
the least and greatest, for range filters and histograms (`summary.<level>`
and `_all` hold text). Columns a `search.unit_conversions` entry names are
in its base unit (ages in years BP by their age_unit); values that are not
numbers are left out.

Every doc also has `summary._has`: per table, the sorted names of its
data-model columns (those the with/without data filter lists, see
`NodeConfig.exists_columns`) with a value in any of the doc's rows, as
keywords. The contribution doc's covers every table of the contribution
(criteria, ages, images too); a record's its own table's and those of the
records below it that name it (a location's: its sites', samples', ...).
`summary._has._any` is the union of a doc's tables'.

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
from fiesta.nodeconfig import (
    ANY_TABLE,
    BOX_COLUMNS,
    LAT_COLUMNS,
    LON_COLUMNS,
    NodeConfig,
    number,
)

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


def _point(lat: float | None, lon: float | None) -> dict | None:
    if lat is None or lon is None or not (-90 <= lat <= 90):
        return None
    return {"lat": lat, "lon": _wrap(lon)}


def _lat_lon(row: dict) -> dict | None:
    """A row's own lat/lon, or its box when the box is a single point."""
    if (point := _point(_to_float(row.get("lat")), _to_float(row.get("lon")))) is not None:
        return point
    west, south, east, north = (_to_float(row.get(c)) for c in BOX_COLUMNS)
    if None in (west, south, east, north) or south != north or _wrap(west) != _wrap(east):
        return None
    return _point(south, west)


def _box_centre(row: dict) -> dict | None:
    """The middle of a row's box (lat_s/lat_n, lon_w/lon_e): of the two boxes
    its longitudes bound, one each way round the globe, the narrower, so
    swapped corners don't put it on the far side of the world."""
    box = [_to_float(row.get(c)) for c in BOX_COLUMNS]
    if any(v is None for v in box):
        return None
    west, south, east, north = box
    if east - west < 360:
        west, east = _wrap(west), _wrap(east)
        if (east - west) % 360 > 180:
            west, east = east, west
        if west > east:
            east += 360
    return _point((south + north) / 2, (west + east) / 2)


def _geo_point(row: dict) -> dict | None:
    """A row's position: its lat/lon, or the middle of its box, or its first
    lat/lon-like column (lat_s, lon_w, ...)."""
    if (point := _lat_lon(row) or _box_centre(row)) is not None:
        return point
    lat = next((v for c in LAT_COLUMNS if (v := _to_float(row.get(c))) is not None), None)
    lon = next((v for c in LON_COLUMNS if (v := _to_float(row.get(c))) is not None), None)
    return _point(lat, lon)


# Distinct positions on the contribution doc (enough to match an area anywhere
# in a large study while keeping the doc bounded).
MAX_GEO_POINTS = 500


# Distinct-values cap per column in summary._all (keeps huge contributions'
# roll-up docs bounded; facets and free-text search degrade gracefully).
MAX_ALL_VALUES = 500

# A record's geography (the grid's Geography tile): its own values and those
# of the records above it that it names, as the legacy summaries inherited
# their parents', so a specimen shows and filters on its site's location and
# that location's country.
GEOLOGIC_COLUMNS = ["plate_blocks", "terranes", "geological_province_sections", "tectonic_settings"]
GEOGRAPHIC_COLUMNS = [
    "continent_ocean",
    "country",
    "ocean_sea",
    "region",
    "village_city",
    "location",
    "location_type",
    "location_alternatives",
]
INHERITED_COLUMNS = (*GEOLOGIC_COLUMNS, *GEOGRAPHIC_COLUMNS)


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


class _Numbers:
    """A record's (or the contribution's) number columns' values, for
    `summary._num`: per column the distinct values, up to MAX_ALL_VALUES of
    them, and always its least and greatest, so a range filter and a
    histogram's extent see the ends of even a capped column."""

    def __init__(self) -> None:
        self.values: dict[str, set[float]] = {}
        self.ends: dict[str, list[float]] = {}

    def add(self, column: str, value: float) -> None:
        bucket = self.values.setdefault(column, set())
        if len(bucket) < MAX_ALL_VALUES:
            bucket.add(value)
        ends = self.ends.get(column)
        if ends is None:
            self.ends[column] = [value, value]
        else:
            ends[0], ends[1] = min(ends[0], value), max(ends[1], value)

    def add_rows(self, node: NodeConfig, columns: list[str], rows: list[dict]) -> None:
        """The rows' values of `columns`, in the base unit of those a unit
        conversion names (an age by its age_unit); text and blanks skipped."""
        conversions = node.search.unit_conversions
        converted = {c for conversion in conversions for c in conversion.all_columns}
        wanted = set(columns)
        plain = wanted - converted
        for row in rows:
            for column, cell in row.items():
                if column in plain and (value := number(cell)) is not None:
                    self.add(column, value)
            for conversion in conversions:
                for column, value in conversion.convert(row).items():
                    if column in wanted:
                        self.add(column, value)

    def update(self, other: "_Numbers") -> None:
        """Another's values too (a record's, into its contribution's)."""
        for column, values in other.finalize().items():
            for value in values:
                self.add(column, value)

    def finalize(self) -> dict[str, list[float]]:
        return {
            column: sorted(bucket | set(self.ends[column]))
            for column, bucket in self.values.items()
        }


def _num_block(numbers: _Numbers) -> dict:
    """A doc's `summary._num` entry, left out when it has no numbers."""
    values = numbers.finalize()
    return {"_num": values} if values else {}


def _has_value(value: Any) -> bool:
    """Whether a cell holds data (not blank, not an empty list)."""
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True


def _columns_with_data(rows: list[dict], columns: set[str]) -> set[str]:
    """Which of `columns` have a value in any of the rows."""
    found: set[str] = set()
    for row in rows:
        for column, value in row.items():
            if column in columns and column not in found and _has_value(value):
                found.add(column)
        if len(found) == len(columns):
            break
    return found


def _has_block(has: dict[str, set[str]]) -> dict:
    """A doc's `summary._has` entry: each table's columns with data, sorted,
    and their union under ANY_TABLE; left out when it has none."""
    tables = {table: sorted(columns) for table, columns in has.items() if columns}
    if not tables:
        return {}
    union = sorted({column for columns in has.values() for column in columns})
    return {"_has": {**tables, ANY_TABLE: union}}


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


# A position by (body, lat, lon), with Earth's body None.
PointKey = tuple[str | None, float, float]


def _point_key(point: dict, body: str | None) -> PointKey:
    return (body, round(point["lat"], 4), round(point["lon"], 4))


def _placements(points: dict[PointKey, dict]) -> dict:
    """A record's positions as its `summary._all` entries: one point, or a
    list of them, under `_geo_point` on Earth and `_body_point` elsewhere."""
    earth = [p for (body, *_), p in points.items() if body is None]
    elsewhere = [{**p, "body": body} for (body, *_), p in points.items() if body is not None]
    result: dict[str, Any] = {}
    if earth:
        result["_geo_point"] = earth[0] if len(earth) == 1 else earth
    if elsewhere:
        result["_body_point"] = elsewhere[0] if len(elsewhere) == 1 else elsewhere
    return result


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
    all_numbers = _Numbers()
    level_counts: dict[str, dict] = {}
    # Every level's positions by row name ({"samples": {"S1-a": point}}), for
    # the rows below it that have none of their own.
    positions: dict[str, dict[str, dict]] = {}
    # Each record's points: its rows' lat/lon and, for an area (a location, a
    # box), those of the records below it once every level is read, so it is
    # mapped where its sites are. Its box's centre, or its ancestor's
    # position, only without any.
    placements: list[dict[str, Any]] = []
    named: dict[tuple[str, str], dict[str, Any]] = {}
    # Each named record's geography, own and inherited ({("sites", "S1"): {...}}).
    inherited: dict[tuple[str, str], dict[str, set]] = {}
    areas = node.area_tables
    bodies = planetary_bodies(node, parsed)
    levels = hierarchy[1:]
    # The columns summary._has records per table, and the contribution's.
    has_columns = {
        table: set(node.exists_columns(table))
        for table in node.exists_tables(hierarchy[0])
        if table != ANY_TABLE
    }
    contribution_has: dict[str, set[str]] = {
        table: _columns_with_data(parsed.tables.get(table, []), columns)
        for table, columns in has_columns.items()
        if table not in levels
    }

    for index, level in enumerate(levels):
        rows = parsed.tables.get(level, [])
        level_counts[level] = {"_n_results": len(rows)}
        columns_def = model["tables"].get(level, {}).get("columns", {})
        _collect_all(columns_def, rows, all_values)
        number_columns = node.number_columns(level)
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
            # The nearest record above it that it names carries its own
            # ancestors' geography already (a sample's site has its location's).
            above = next(
                (
                    inherited[key]
                    for ancestor, column in ancestors
                    if (key := (ancestor, str(merged.get(column) or ""))) in inherited
                ),
                {},
            )
            for column, values in above.items():
                bucket = row_all.setdefault(column, set())
                if len(bucket) < MAX_ALL_VALUES:
                    bucket.update(values)
            if name not in (None, ""):
                inherited.setdefault(
                    (level, str(name)),
                    {c: set(row_all[c]) for c in INHERITED_COLUMNS if row_all.get(c)},
                )
            own_has = _columns_with_data(group, has_columns.get(level, set()))
            contribution_has.setdefault(level, set()).update(own_has)
            row_numbers = _Numbers()
            row_numbers.add_rows(node, number_columns, group)
            all_numbers.update(row_numbers)
            points: dict[PointKey, dict] = {}
            for row in group:
                if (point := _lat_lon(row)) is not None and len(points) < MAX_GEO_POINTS:
                    points.setdefault(_point_key(point, body), point)
            own = geo = next((p for row in group if (p := _geo_point(row))), None)
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
            doc = {
                "type": level,
                "summary": {
                    "contribution": contribution_summary,
                    level: {**merged, "_n_results": len(group)},
                    "_all": _finalize_all(row_all, None),
                    **_num_block(row_numbers),
                },
                "rows": group,
            }
            docs.append(doc)
            # The nearest record above it that it names.
            parent = next(
                (
                    named[key]
                    for ancestor, column in ancestors
                    if (key := (ancestor, str(merged.get(column) or ""))) in named
                ),
                None,
            )
            placement = {"doc": doc, "body": body, "points": points, "own": own, "geo": geo}
            placements.append(
                {**placement, "parent": parent, "below": dict(points), "has": {level: own_has}}
            )
            placements[-1]["area"] = level in areas
            if name not in (None, ""):
                named.setdefault((level, str(name)), placements[-1])

    # The deepest records first, so each passes its descendants' points on too
    # (a sample's through its site to its location).
    # Their columns with data too (a measurement's through its specimen, ...).
    for placement in reversed(placements):
        if (above := placement["parent"]) is not None:
            for table, columns in placement["has"].items():
                above["has"].setdefault(table, set()).update(columns)
            for key, point in placement["below"].items():
                if len(above["below"]) >= MAX_GEO_POINTS:
                    break
                above["below"].setdefault(key, point)
    # The contribution's: every record's points, or its own box's centre.
    points: dict[PointKey, dict] = {}
    for placement in placements:
        mapped = placement["below" if placement["area"] else "points"]
        body, geo, own = (placement[k] for k in ("body", "geo", "own"))
        placement["doc"]["summary"].update(_has_block(placement["has"]))
        all_block = placement["doc"]["summary"]["_all"]
        all_block.update(_placements(mapped) if mapped else placed(geo, body) if geo else {})
        for key, point in (mapped or ({_point_key(own, body): own} if own else {})).items():
            if len(points) < MAX_GEO_POINTS:
                points.setdefault(key, point)

    contribution_doc = {
        "type": "contribution",
        "summary": {
            "contribution": contribution_summary,
            "_all": _finalize_all(
                all_values,
                [p for (body, *_), p in points.items() if body is None] or None,
                [{**p, "body": body} for (body, *_), p in points.items() if body is not None],
            ),
            **_num_block(all_numbers),
            **_has_block(contribution_has),
            **level_counts,
        },
    }
    return [contribution_doc, *docs]


def doc_id(contribution_id: int, doc_type: str, ordinal: int) -> str:
    return f"{contribution_id}-{doc_type}-{ordinal}"
