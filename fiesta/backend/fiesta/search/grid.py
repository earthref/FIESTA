"""The search page's summary grid: each level's columns, resolved.

A level's `columns` (node YAML `search.levels[].columns`, or the default tiles
when unset) name tiles; this module gives each its header label, width, and
the document paths its header sorts and filters on. The SPA renders the tiles
and sends `sort=<key>:asc|desc` and `filter=<key>:<text>`; the search router
turns those into OpenSearch clauses here, so only configured columns are ever
sortable or filterable. A column's header menu offers its `facets` (summary._all
columns) as the sidebar's checkbox lists: they filter through the search box's
`<column>:"<value>"` tokens and are counted with `facet=<column>`. A column
without facets (or configured with `facets: []`) gets a text box over its
filter fields instead; configured `filter_fields` add one to a faceted column.

Summary values are indexed as strings (text + `.raw` keyword), so a numeric
column sorts through a script that parses its `.raw` values; the rest sort on
the keyword (or the typed timestamp / id). A `show: range` data tile sorts on
the same script over the typed `summary._num` doubles and has no text filter.
"""

import re
from dataclasses import dataclass, field
from typing import Literal

from fiesta.nodeconfig import GridColumn, GridLine, NodeConfig, SearchLevel

SortType = Literal["keyword", "number", "date", "long"]

_CONTRIBUTION = "summary.contribution"
_REFERENCE = f"{_CONTRIBUTION}._reference"

# The default tiles, in the legacy result card's order, with the active
# plugins' default tiles (FiestaPlugin.grid_tiles) between the two lists;
# download and links exist only on contribution records.
DEFAULT_CELLS = ["record", "download", "links", "counts", "map", "plot", "geo"]
DEFAULT_TAIL_CELLS = ["citations"]
CONTRIBUTION_ONLY = {"download", "links"}


@dataclass
class Sort:
    fields: list[str]
    type: SortType


@dataclass
class ResolvedColumn:
    key: str
    cell: str
    label: str
    width: int
    column: str | None = None
    subtitle_column: str | None = None
    format: str | None = None
    sort: Sort | None = None
    filter_fields: list[str] = field(default_factory=list)
    facets: list[str] = field(default_factory=list)
    geospatial: bool = False
    show: str | None = None
    # A field / fields tile's lines: {column, label, unit?, number}.
    lines: list[dict] = field(default_factory=list)

    def public(self) -> dict:
        out = {
            "key": self.key,
            "cell": self.cell,
            "label": self.label,
            "width": self.width,
            "sortable": self.sort is not None,
            "filterable": bool(self.filter_fields),
            "facets": self.facets,
            "geospatial": self.geospatial,
        }
        for name in ("column", "subtitle_column", "format", "show", "lines"):
            if value := getattr(self, name):
                out[name] = value
        return out


def _all(*columns: str) -> list[str]:
    return [f"summary._all.{c}" for c in columns]


def _singular(name: str) -> str:
    return name[:-1] if name.endswith("s") else name


# Data-model types whose values are worth listing as facet buckets.
_FACET_TYPES = {"String", "List"}
_NUMBER_TYPES = {"Number", "Integer"}
# Data-model units that say nothing next to a value (an age's is its row's
# age_unit, a flag's its vocabulary).
_SILENT_UNITS = {"", "Custom", "Dimensionless", "SI Dimensionless", "Flag", "Number"}


_SUPERSCRIPTS = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")


_UNIT_SYMBOLS = {
    "Degrees": "°",
    "Meters": "m",
    "Centimeters": "cm",
    "Millimeters": "mm",
    "Kilometers": "km",
    "Square Kilometers": "km²",
    "Cubic Kilometers": "km³",
    "Kilograms": "kg",
    "Grams": "g",
}


def _display_unit(unit: str) -> str:
    """A data-model unit as a tile shows it: "Degrees" → "°", "Am^2" → "Am²"."""
    if unit in _UNIT_SYMBOLS:
        return _UNIT_SYMBOLS[unit]
    return re.sub(r"\^(-?\d+)", lambda m: m.group(1).translate(_SUPERSCRIPTS), unit)


@dataclass
class _Line:
    """One data column of a field / fields tile, resolved for its `show`."""

    public: dict
    sort: Sort | None
    filters: list[str]
    facets: list[str]


def _line(node: NodeConfig, table: str, spec: GridLine, show: str, columns: dict) -> _Line:
    name = spec.column
    definition = columns.get(name, {})
    kind = definition.get("type")
    number = kind in _NUMBER_TYPES
    unit = definition.get("unit") or ""
    if show == "range":
        # summary._num holds a unit conversion's columns in its base unit.
        base = {c: conv.unit for conv in node.search.unit_conversions for c in conv.all_columns}
        unit = base.get(name) or unit
        sort, filters, facets = Sort([f"summary._num.{name}"], "number"), [], []
    else:
        path = f"summary.{table}.{name}" if show == "value" else f"summary._all.{name}"
        sort = Sort([f"{path}.raw"], "number" if number else "keyword")
        filters = [path]
        facets = [name] if kind in _FACET_TYPES else []
    label = spec.label or definition.get("label") or name
    public: dict = {"column": name, "label": label, "number": number}
    if spec.unit is not None:
        unit = spec.unit
    if unit not in _SILENT_UNITS:
        public["unit"] = _display_unit(unit)
    if spec.scale is not None:
        public["scale"] = spec.scale
    return _Line(public, sort, filters, facets)


def _data_lines(node: NodeConfig, level: SearchLevel, col: GridColumn, columns: dict) -> list:
    """A field / fields tile's lines (a title has none)."""
    if col.cell == "fields":
        specs = list(col.columns or [])
    elif col.cell == "field" and col.column:
        specs = [GridLine(column=col.column)]
    else:
        return []
    show = col.show or "value"
    lines = [_line(node, level.table, spec, show, columns) for spec in specs]
    if col.cell == "field" and col.show is None:
        # As before `show`: the value as typed, its unit in the header.
        for line in lines:
            line.public.pop("unit", None)
            line.public["number"] = False
    return lines


def _defaults(
    node: NodeConfig, level: SearchLevel, col: GridColumn, columns: dict, tiles: dict
) -> tuple[str, int, Sort | None, list[str], list[str]]:
    """A tile's default header label, width, sort, text filter fields and
    facets; `tiles` are the active plugins' (`_plugin_tiles`)."""
    table = level.table
    match col.cell:
        case "record":
            # Citation, name and contributed in one column: the level's record
            # ("Contribution", "Site"), sorted like its first line that differs
            # per level (citation, or the record's name), filtered on all three.
            parts = [
                _defaults(node, level, GridColumn(cell=cell), columns, tiles)
                for cell in ("citation", "name", "contributed")
            ]
            filters = list(dict.fromkeys(f for part in parts for f in part[3]))
            sort = parts[0][2] if table == "contribution" else parts[1][2]
            label = "Contribution" if table == "contribution" else _singular(level.name)
            return label, 260, sort, filters, []
        case "citation":
            return (
                "Citation",
                220,
                Sort([f"{_REFERENCE}.citation.raw"], "keyword"),
                [f"{_REFERENCE}.citation"],
                [],
            )
        case "name":
            if table == "contribution":
                return (
                    "Title",
                    260,
                    Sort([f"{_REFERENCE}.title.raw"], "keyword"),
                    [f"{_REFERENCE}.title"],
                    [],
                )
            # The breadcrumb: this level's name and its ancestors'.
            chain = [table]
            if table in node.hierarchy:
                chain = node.hierarchy[: node.hierarchy.index(table) + 1]
            key = _singular(table)
            return (
                _singular(level.name),
                220,
                Sort([f"summary.{table}.{key}.raw"], "keyword"),
                _all(*(_singular(t) for t in chain if t != "contribution")),
                [],
            )
        case "contributed":
            return (
                "Contributed",
                190,
                Sort([f"{_CONTRIBUTION}.timestamp"], "date"),
                [f"{_CONTRIBUTION}._contributor"],
                [],
            )
        case "download":
            return "Download", 100, None, [], []
        case "links":
            return "Links", 200, Sort([f"{_CONTRIBUTION}.id"], "long"), [f"{_REFERENCE}.doi"], []
        case "counts":
            # One "25.6 k Measurements" line per level with a count: a
            # contribution counts every level, a record only its own rows
            # (summarize gives it just its level's `_n_results`). Wide enough
            # for the longest label it can show: 160px for "Measurements",
            # 104px for "Sites".
            names = [
                entry.name
                for entry in node.search.levels
                if entry.count_field and (table == "contribution" or entry.table == table)
            ]
            return "Counts", 64 + 8 * max(map(len, names), default=5), None, [], []
        case "map":
            return "Map", 100, None, [], []
        case "plot":
            return "Plot", 100, None, [], []
        case "geo":
            geography = node.search.geography.columns
            return "Geography", 125, None, _all(*geography), geography
        case "citations":
            return "Citations", 125, None, _all("citations", "citation_dois"), ["citations"]
        case "field" | "fields":
            # Sorted on its first line, filtered on all of them; the header is
            # the field's label, or the lines' shared data-model group
            # ("Direction"), else the first line's.
            lines = _data_lines(node, level, col, columns)
            groups = {columns.get(line.public["column"], {}).get("group") for line in lines}
            label = lines[0].public["label"]
            if col.cell == "fields" and len(groups) == 1 and None not in groups:
                label = str(groups.pop())
            width = 160 if col.cell == "fields" else 120
            filters = list(dict.fromkeys(f for line in lines for f in line.filters))
            facets = list(dict.fromkeys(f for line in lines for f in line.facets))
            return label, width, lines[0].sort, filters, facets
        case "title":  # one column of the level's summary block, in bold
            path = f"summary.{table}.{col.column}"
            kind = columns.get(col.column, {}).get("type")
            label = columns.get(col.column, {}).get("label") or str(col.column)
            sort = Sort([f"{path}.raw"], "number" if kind == "Number" else "keyword")
            filters = [path]
            if col.subtitle_column:
                filters.append(f"summary.{table}.{col.subtitle_column}")
            # One per record: typed into a text box, not listed as facets.
            return label, 300, sort, filters, []
        case cell:  # a plugin's tile (fiesta.plugins.active_plugins checked the name)
            if cell not in tiles:
                raise ValueError(f"no grid tile {cell!r} on node {node.node.key!r}")
            plugin, tile = tiles[cell]
            fields = plugin.grid_tile_fields(node, level, cell)
            sort = Sort(fields.sort_fields, fields.sort_type) if fields.sort_fields else None
            return tile.label, tile.width, sort, fields.filter_fields, fields.facets


def _plugin_tiles(node: NodeConfig) -> dict:
    """{cell: (plugin, GridTile)} for the tiles the node's active plugins add."""
    from fiesta.plugins import active_plugins

    return {
        tile.cell: (plugin, tile) for plugin in active_plugins(node) for tile in plugin.grid_tiles
    }


def level_columns(node: NodeConfig, level: SearchLevel) -> list[ResolvedColumn]:
    """The level's grid columns with every default filled in."""
    configured = level.columns
    tiles = _plugin_tiles(node)
    if configured is None:
        plugin_defaults = [cell for cell, (_, tile) in tiles.items() if tile.default]
        configured = [
            GridColumn(cell=cell)
            for cell in [*DEFAULT_CELLS, *plugin_defaults, *DEFAULT_TAIL_CELLS]
            if level.table == "contribution" or cell not in CONTRIBUTION_ONLY
        ]
    tables = node.load_data_model(node.data_model.latest)["tables"]
    # The level's columns, then (for a contribution's values, a record's
    # geography) the other tables'.
    columns = {
        **{k: v for t in tables.values() for k, v in t.get("columns", {}).items()},
        **tables.get(level.table, {}).get("columns", {}),
    }
    # A map tile's menu holds the Map tab's area, on levels with positions.
    geo = level.table in node.geo_tables
    out = []
    for col in configured:
        label, width, sort, filters, facets = _defaults(node, level, col, columns, tiles)
        if col.sort_field:
            numeric = col.numeric
            if numeric is None:
                numeric = sort is not None and sort.type == "number"
            sort = Sort([col.sort_field], "number" if numeric else "keyword")
        elif sort is not None and col.numeric is not None:
            sort = Sort(sort.fields, "number" if col.numeric else "keyword")
        # The header menu lists the facets; the text box is the fallback for a
        # column without them (`facets: []`), or configured `filter_fields`.
        facets = (facets if col.facets is None else col.facets) if col.filterable else []
        filter_fields = (col.filter_fields or ([] if facets else filters)) if col.filterable else []
        out.append(
            ResolvedColumn(
                key=col.key,
                cell=col.cell,
                label=col.label or label,
                width=col.width or width,
                column=col.column,
                subtitle_column=col.subtitle_column,
                format=col.format,
                sort=sort if col.sortable else None,
                filter_fields=filter_fields,
                facets=facets,
                geospatial=col.cell == "map" and col.filterable and geo,
                show=col.show,
                lines=[line.public for line in _data_lines(node, level, col, columns)],
            )
        )
    return out


def public_columns(node: NodeConfig, level: SearchLevel) -> list[dict]:
    return [c.public() for c in level_columns(node, level)]


# Numeric sort over string values: the smallest (ascending) or largest
# (descending) value of the fields that parses as a number; a record with none
# sorts last either way. No `continue`: Painless fails to compile one inside a
# catch block ("label is null"), which made every numeric header sort a 500.
_NUMBER_SCRIPT = """
boolean asc = params.asc; boolean hit = false;
double best = asc ? Double.MAX_VALUE : -Double.MAX_VALUE;
for (String f : params.fields) {
  if (doc.containsKey(f)) {
    for (def v : doc[f]) {
      double d = 0; boolean parsed = true;
      if (v instanceof Number) { d = ((Number) v).doubleValue(); }
      else {
        try { d = Double.parseDouble(v.toString().trim()); }
        catch (NumberFormatException e) { parsed = false; }
      }
      if (parsed) {
        hit = true;
        best = asc ? Math.min(best, d) : Math.max(best, d);
      }
    }
  }
}
return hit ? best : (asc ? Double.MAX_VALUE : -Double.MAX_VALUE);
"""


def sort_clauses(column: ResolvedColumn, order: Literal["asc", "desc"]) -> list:
    """OpenSearch sort clauses for a column header, newest first on ties."""
    assert column.sort is not None
    sort = column.sort
    tie = {f"{_CONTRIBUTION}.timestamp": {"order": "desc", "unmapped_type": "date"}}
    if sort.type == "number":
        clause = {
            "_script": {
                "type": "number",
                "order": order,
                "script": {
                    "lang": "painless",
                    "source": _NUMBER_SCRIPT,
                    "params": {"fields": sort.fields, "asc": order == "asc"},
                },
            }
        }
        return [clause, tie]
    clauses: list = [
        {f: {"order": order, "unmapped_type": sort.type, "missing": "_last"}} for f in sort.fields
    ]
    return [*clauses, tie]


ROW_SORT_PREFIX = "rows."
_ROW_COLUMN = re.compile(r"^[A-Za-z0-9_]+$")


def row_sort_clauses(
    node: NodeConfig, table: str, column: str, order: Literal["asc", "desc"]
) -> list | None:
    """OpenSearch sort clauses for a Rows grid header (`sort=rows.<column>:…`):
    records by their rows' smallest (ascending) or largest (descending) value
    of the column, numerically for a data-model Number. Raw rows are not
    indexed, so this reads the record's `summary._all` values and, for the ID
    columns `_all` leaves out, its merged `summary.<table>` row. None for a
    name that is not a column."""
    if not _ROW_COLUMN.match(column):
        return None
    tables = node.load_data_model(node.data_model.latest)["tables"]
    kind = tables.get(table, {}).get("columns", {}).get(column, {}).get("type")
    fields = [f"summary._all.{column}.raw", f"summary.{table}.{column}.raw"]
    return sort_clauses(
        ResolvedColumn(
            key=column,
            cell="field",
            label=column,
            width=0,
            sort=Sort(fields, "number" if kind == "Number" else "keyword"),
        ),
        order,
    )


_SPECIAL = re.compile(r'([+\-=&|><!(){}\[\]^"~*?:\\/|])')


def filter_clause(column: ResolvedColumn, text: str) -> dict | None:
    """Records whose filter fields hold every typed word (as a prefix)."""
    words = [_SPECIAL.sub(r"\\\1", w) for w in text.split()]
    if not words or not column.filter_fields:
        return None
    return {
        "simple_query_string": {
            "query": " ".join(f"{w}*" for w in words),
            "fields": column.filter_fields,
            "default_operator": "and",
            "lenient": True,
            "analyze_wildcard": True,
        }
    }
