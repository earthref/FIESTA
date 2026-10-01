"""The search page's summary grid: each level's columns, resolved.

A level's `columns` (node YAML `search.levels[].columns`, or the default tiles
when unset) name tiles; this module gives each its header label, width, and
the document paths its header sorts and filters on. The SPA renders the tiles
and sends `sort=<key>:asc|desc` and `filter=<key>:<text>`; the search router
turns those into OpenSearch clauses here, so only configured columns are ever
sortable or filterable.

Summary values are indexed as strings (text + `.raw` keyword), so a numeric
column sorts through a script that parses its `.raw` values; the rest sort on
the keyword (or the typed timestamp / id).
"""

import re
from dataclasses import dataclass, field
from typing import Literal

from fiesta.nodeconfig import GridColumn, NodeConfig, SearchLevel

SortType = Literal["keyword", "number", "date", "long"]

_CONTRIBUTION = "summary.contribution"
_REFERENCE = f"{_CONTRIBUTION}._reference"
_GEOLOGIC = ["plate_blocks", "terranes", "geological_province_sections", "tectonic_settings"]
_GEOGRAPHIC = [
    "continent_ocean",
    "country",
    "ocean_sea",
    "region",
    "village_city",
    "location",
    "location_type",
    "location_alternatives",
]

# The default tiles, in the legacy result card's order; download and links
# exist only on contribution records.
DEFAULT_CELLS = [
    "record",
    "download",
    "links",
    "counts",
    "map",
    "plot",
    "geo",
    "geology",
    "age",
    "intensity",
    "method_codes",
    "citations",
]
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

    def public(self) -> dict:
        out = {
            "key": self.key,
            "cell": self.cell,
            "label": self.label,
            "width": self.width,
            "sortable": self.sort is not None,
            "filterable": bool(self.filter_fields),
        }
        for name in ("column", "subtitle_column", "format"):
            if value := getattr(self, name):
                out[name] = value
        return out


def _all(*columns: str) -> list[str]:
    return [f"summary._all.{c}" for c in columns]


def _singular(name: str) -> str:
    return name[:-1] if name.endswith("s") else name


def _defaults(
    node: NodeConfig, level: SearchLevel, col: GridColumn, columns: dict
) -> tuple[str, int, Sort | None, list[str]]:
    """A tile's default header label, width, sort and filter fields."""
    table = level.table
    match col.cell:
        case "record":
            # Citation, name and contributed in one column: the level's record
            # ("Contribution", "Site"), sorted like its first line that differs
            # per level (citation, or the record's name), filtered on all three.
            parts = [
                _defaults(node, level, GridColumn(cell=cell), columns)
                for cell in ("citation", "name", "contributed")
            ]
            filters = list(dict.fromkeys(f for part in parts for f in part[3]))
            sort = parts[0][2] if table == "contribution" else parts[1][2]
            label = "Contribution" if table == "contribution" else _singular(level.name)
            return label, 260, sort, filters
        case "citation":
            return (
                "Citation",
                220,
                Sort([f"{_REFERENCE}.citation.raw"], "keyword"),
                [f"{_REFERENCE}.citation"],
            )
        case "name":
            if table == "contribution":
                return (
                    "Title",
                    260,
                    Sort([f"{_REFERENCE}.title.raw"], "keyword"),
                    [f"{_REFERENCE}.title"],
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
            )
        case "contributed":
            return (
                "Contributed",
                190,
                Sort([f"{_CONTRIBUTION}.timestamp"], "date"),
                [f"{_CONTRIBUTION}._contributor"],
            )
        case "download":
            return "Download", 100, None, []
        case "links":
            return "Links", 200, Sort([f"{_CONTRIBUTION}.id"], "long"), [f"{_REFERENCE}.doi"]
        case "counts":
            return "Counts", 160, None, []
        case "map":
            return "Map", 100, None, []
        case "plot":
            return "Plot", 100, None, []
        case "geo":
            return "Geography", 125, None, _all(*_GEOLOGIC, *_GEOGRAPHIC)
        case "geology":
            return (
                "Geology",
                125,
                Sort(_all("geologic_classes.raw"), "keyword"),
                _all("geologic_classes", "geologic_types", "lithologies"),
            )
        case "age":
            return "Age", 120, Sort(_all("ages.raw", "age.raw"), "number"), _all("ages", "age")
        case "intensity":
            return (
                "Intensity",
                90,
                Sort(_all("int_abs.raw", "intensities.raw"), "number"),
                [],
            )
        case "method_codes":
            return (
                "Method Codes",
                125,
                Sort(_all("method_codes.raw"), "keyword"),
                _all("method_codes"),
            )
        case "citations":
            return "Citations", 125, None, _all("citations", "citation_dois")
        case _:  # field / title: one column of the level's summary block
            path = f"summary.{table}.{col.column}"
            numeric = columns.get(col.column, {}).get("type") == "Number"
            label = columns.get(col.column, {}).get("label") or str(col.column)
            filters = [path]
            if col.cell == "title" and col.subtitle_column:
                filters.append(f"summary.{table}.{col.subtitle_column}")
            width = 300 if col.cell == "title" else 120
            return label, width, Sort([f"{path}.raw"], "number" if numeric else "keyword"), filters


def level_columns(node: NodeConfig, level: SearchLevel) -> list[ResolvedColumn]:
    """The level's grid columns with every default filled in."""
    configured = level.columns
    if configured is None:
        configured = [
            GridColumn(cell=cell)
            for cell in DEFAULT_CELLS
            if level.table == "contribution" or cell not in CONTRIBUTION_ONLY
        ]
    tables = node.load_data_model(node.data_model.latest)["tables"]
    columns = tables.get(level.table, {}).get("columns", {})
    out = []
    for col in configured:
        label, width, sort, filters = _defaults(node, level, col, columns)
        if col.sort_field:
            numeric = col.numeric
            if numeric is None:
                numeric = sort is not None and sort.type == "number"
            sort = Sort([col.sort_field], "number" if numeric else "keyword")
        elif sort is not None and col.numeric is not None:
            sort = Sort(sort.fields, "number" if col.numeric else "keyword")
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
                filter_fields=(col.filter_fields or filters) if col.filterable else [],
            )
        )
    return out


def public_columns(node: NodeConfig, level: SearchLevel) -> list[dict]:
    return [c.public() for c in level_columns(node, level)]


# Numeric sort over string values: the smallest (ascending) or largest
# (descending) value of the fields that parses as a number; a record with none
# sorts last either way.
_NUMBER_SCRIPT = """
boolean asc = params.asc; boolean hit = false;
double best = asc ? Double.MAX_VALUE : -Double.MAX_VALUE;
for (String f : params.fields) {
  if (!doc.containsKey(f)) continue;
  for (def v : doc[f]) {
    double d;
    if (v instanceof Number) { d = ((Number) v).doubleValue(); }
    else {
      try { d = Double.parseDouble(v.toString().trim()); }
      catch (NumberFormatException e) { continue; }
    }
    hit = true;
    best = asc ? Math.min(best, d) : Math.max(best, d);
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
