"""Deployment configuration loader.

A FIESTA deployment is `configurations/fiesta.yaml`: the node YAMLs (MagIC, CDR,
KArAr, ...) one API process serves. Each node YAML fully describes that node;
a node YAML also loads on its own as a one-node deployment. Large assets
(data models, controlled vocabularies) are JSON files referenced from the
YAML, resolved relative to the YAML file's directory.
"""

import json
import math
import re
from pathlib import Path
from typing import Any, ClassVar, Literal

import yaml
from pydantic import BaseModel, Field, PrivateAttr, field_validator, model_validator

from fiesta.settings import get_settings

# Data-model columns that place a row: the first of each present is its
# position (summary._all._geo_point); lat_s/lat_n/lon_w/lon_e are a box.
LAT_COLUMNS = ("lat", "lat_s", "lat_n")
LON_COLUMNS = ("lon", "lon_w", "lon_e")
BOX_COLUMNS = ("lon_w", "lat_s", "lon_e", "lat_n")
# All of them: the Geospatial filter's, so no `numeric` filter of their own.
POSITION_COLUMNS = frozenset(LAT_COLUMNS + LON_COLUMNS)
# Data-model column types also indexed as numbers, in summary._num.<column>.
NUMBER_TYPES = {"Number", "Integer"}
# Number columns that are ids, not measurements (FIESTA's row stamps).
NUMBER_ID_COLUMNS = {"contribution_id", "row_id"}
# Data-model column types the `text` filter offers as facets (summary._all.<column>.raw);
# Matrix and Dictionary values are structured, Timestamps dates.
TEXT_TYPES = {"String", "List"}
# The with/without data filter's "any table" tab (summary._has._any: the
# union of a doc's tables' columns with data).
ANY_TABLE = "_any"
# Planetary bodies other than Earth that a row's position can be on, which the
# maps and thumbnails have a basemap for (fiesta/frontend/src/components/map/bodies.ts).
Body = Literal["moon"]

PAGE_SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
# SPA routes a content page can never shadow (fiesta/frontend/src/router.tsx;
# plugin pages are checked by fiesta.plugins.active_plugins).
RESERVED_PAGE_SLUGS = {
    "search",
    "contribution",
    "contributions",
    "upload",
    "private",
    "validate",
    "data-models",
    "vocabularies",
    "login",
    "contact",
    "admin",
    "users",
    "references",
}


class NodeLinks(BaseModel):
    website: str | None = None
    github_issues: str | None = None


class NodeIdentity(BaseModel):
    key: str
    slug: str
    title: str
    subtitle: str = ""
    color: str = "#666666"
    logo: str | None = (
        None  # path under configurations/<slug>/assets/ (the portal home's node cards)
    )
    links: NodeLinks = NodeLinks()

    @field_validator("slug")
    @classmethod
    def _not_a_reserved_queue(cls, value: str) -> str:
        """The slug names the node's job queue; `default` and `ops` are taken."""
        from fiesta.jobs.queues import RESERVED_QUEUES

        if value in RESERVED_QUEUES:
            raise ValueError(f"node slug {value!r} is reserved (job queue name)")
        return value


# The core's summary grid tiles; plugins add their own (FiestaPlugin.grid_tiles).
CORE_GRID_CELLS = (
    "record",
    "citation",
    "name",
    "contributed",
    "download",
    "links",
    "counts",
    "map",
    "plot",
    "geo",
    "citations",
    "field",
    "fields",
    "title",
)


class GridLine(BaseModel):
    """One line of a `fields` tile: a data column, under its data-model label
    or `label` (YAML: the column's name alone, or {column, label, ...}). A
    number shows in its data-model unit (a range in a unit conversion's base
    unit), or divided by `scale` in `unit`, as a range filter's (mT: 1.0e-3)."""

    column: str = Field(pattern=r"^\w+$")
    label: str | None = None
    unit: str | None = None
    scale: float | None = Field(default=None, gt=0)


class GridColumn(BaseModel):
    """One column of a search level's summary grid.

    `cell` names the tile the column shows: a built-in summary tile (record,
    which stacks citation, name and contributed in one column; citation, name,
    contributed, download, links, counts, map, plot, geo, citations), a tile an
    active plugin adds (checked by fiesta.plugins.active_plugins), `field` (one
    data column, "Label: value"), `fields` (several `columns` under one header,
    a "Label: value" line each, blank ones left out) or `title` (a column in
    bold over an optional `subtitle_column`). On `field` and `fields`, `show`
    picks what a record shows of a column: `value`, its own (its first row's,
    `summary.<table>`); `values`, every distinct value of its rows and, on
    Contributions, of the whole contribution (`summary._all`); or `range`, the
    least to greatest of a number column's (`summary._num`, in the base unit of
    a unit conversion). Each tile has a default
    header label, width, sort and filters (fiesta.search.grid); `sortable` /
    `filterable` switch them off, and
    `sort_field` (a `.raw` keyword path, or with `numeric` any string path),
    `filter_fields` (text paths) and `facets` replace them. The header's filter
    menu offers the `facets` (summary._all columns) as the sidebar's checkbox
    lists, a text box over the `filter_fields`, and on a map tile the area.
    """

    cell: str = Field(default="field", pattern=r"^\w+$")
    column: str | None = None
    # At most 5 lines: with its header, what a grid row's height shows.
    columns: list[GridLine] | None = Field(default=None, min_length=1, max_length=5)
    subtitle_column: str | None = None
    show: Literal["value", "values", "range"] | None = None
    label: str | None = None
    width: int | None = Field(default=None, ge=40)
    format: Literal["bytes"] | None = None
    sortable: bool = True
    filterable: bool = True
    sort_field: str | None = None
    numeric: bool | None = None
    filter_fields: list[str] | None = None
    facets: list[str] | None = None

    @field_validator("columns", mode="before")
    @classmethod
    def _lines(cls, value: Any) -> Any:
        """A `fields` line may be just its column's name."""
        if isinstance(value, list):
            return [{"column": v} if isinstance(v, str) else v for v in value]
        return value

    @model_validator(mode="after")
    def _check(self) -> "GridColumn":
        if self.cell in ("field", "title") and not self.column:
            raise ValueError(f"a {self.cell} column needs a column")
        if self.cell not in ("field", "title") and (self.column or self.subtitle_column):
            raise ValueError(f"a {self.cell} column takes no column")
        if self.cell == "fields":
            if not self.columns:
                raise ValueError("a fields column needs columns")
            names = self.data_columns
            if len(set(names)) != len(names):
                raise ValueError(f"a fields column repeats columns: {names}")
        elif self.columns is not None:
            raise ValueError(f"a {self.cell} column takes no columns (a fields column does)")
        if self.show is not None and self.cell not in ("field", "fields"):
            raise ValueError(f"a {self.cell} column takes no show (field and fields do)")
        paths = [self.sort_field or "summary.", *(self.filter_fields or [])]
        if bad := [p for p in paths if not p.startswith("summary.")]:
            raise ValueError(f"grid sort/filter fields must be summary.* paths: {bad}")
        if bad := [f for f in self.facets or [] if not re.fullmatch(r"\w+", f)]:
            raise ValueError(f"grid facets are column names: {bad}")
        return self

    @property
    def data_columns(self) -> list[str]:
        """The data-model columns it shows (none for a summary tile)."""
        if self.cell == "fields":
            return [line.column for line in self.columns or []]
        return [n for n in (self.column, self.subtitle_column) if n]

    @property
    def key(self) -> str:
        """The column's name in sort/filter requests: its data column, its
        columns joined by "-" (never in a column name), or its tile."""
        if self.cell == "fields" and self.columns:
            return "-".join(self.data_columns)
        return self.column if self.cell in ("field", "title") and self.column else self.cell


class SearchLevel(BaseModel):
    name: str
    table: str
    count_field: str | None = None
    # The Summaries grid's columns, in order; None = the default tiles.
    columns: list[GridColumn] | None = None

    @model_validator(mode="after")
    def _unique_columns(self) -> "SearchLevel":
        keys = [c.key for c in self.columns or []]
        if dupes := sorted({k for k in keys if keys.count(k) > 1}):
            raise ValueError(f"search level {self.name!r} repeats grid columns {dupes}")
        return self


class SearchFilter(BaseModel):
    """One control in the search page's filter sidebar.

    `facet`: term buckets of a data-model column, aggregated on
    `summary._all.<field>.raw` and toggled as `field:"value"` query tokens.
    `range`: a numeric min/max on a full document path: a data-model number
    column's `summary._num.<column>` (a record's values as numbers, see
    `NUMBER_TYPES`), or a field a plugin indexes as a number
    (`summary.poles.age`); the merged rows under `summary.<level>` are text.
    `scale` multiplies the typed value before it is sent (Ma -> years).
    `bbox`: the lat/lon box on `summary._all._geo_point`. `numeric`: each of
    the level's `summary._num` columns as a range filter of its own (those no
    `range` filter has). `text`: each of the level's text columns
    (`NodeConfig.text_columns`) as a facet of its own (those no `facet`
    filter has). A facet on `id` or `contributor` (search/queries.py
    CONTRIBUTION_FACETS) is on the contribution block, not `_all`: every
    node's Contribution ID and Contributor filters. `date` (range, on a date
    field: summary.contribution.timestamp, Contributed On): bounds in epoch
    milliseconds, typed and shown as dates.
    `exists`: the with/without data picker, a tab per table the level's docs
    record (`NodeConfig.exists_tables`) listing its data-model columns, each
    ticked one `has=<table>:<column>` (with data) or `has=!<table>:<column>`
    (has the table, not that column) on `summary._has.<table>`.
    `levels` / `views` restrict where the control shows: search level names and
    result sub-tab names (Summaries, Rows, Map on levels with positions, a plugin
    tab); empty means everywhere. `timescale` (range, on a field of ages in
    years): the geologic time scale's units under the histogram, each a
    shortcut to its age range.
    """

    type: Literal["facet", "range", "bbox", "numeric", "text", "exists"]
    field: str | None = None
    label: str | None = None  # facets default to the column's title in the UI
    levels: list[str] = []
    views: list[str] = []
    unit: str | None = None
    scale: float = 1.0
    min: float | None = None
    max: float | None = None
    timescale: bool = False
    date: bool = False

    @model_validator(mode="after")
    def _check_field(self) -> "SearchFilter":
        if self.date and self.type != "range":
            raise ValueError("only a range filter can be a date")
        if self.type == "facet" and self.field == "private_key":
            raise ValueError("a facet can never list contributions' private keys")
        if self.type == "bbox":
            if self.field:
                raise ValueError("a bbox filter has no field (it uses summary._all._geo_point)")
            return self
        if self.type in ("numeric", "text", "exists"):
            if self.field:
                raise ValueError(f"a {self.type} filter has no field (its columns are picked)")
            return self
        if not self.field:
            raise ValueError(f"a {self.type} filter needs a field")
        if self.type == "range" and not self.field.startswith("summary."):
            raise ValueError(f"range filter field {self.field!r} must be a summary.* path")
        if self.type == "facet" and "." in self.field:
            raise ValueError(f"facet filter field {self.field!r} must be a bare column name")
        return self

    @property
    def key(self) -> str:
        return self.field or self.type


class MapColor(BaseModel):
    """A number the search map can color its markers by.

    `field`: a column of the level's rows (`int_abs`, read from
    `summary.<table>.<column>`, offered on the levels whose table has it) or a
    full `summary.*` path (`summary.contribution._reference.year`, offered on
    every level with positions). Row values are text and are parsed as numbers.
    `scale` as a range filter's: a stored value / scale is what the legend
    shows (T -> μT with 1e-6). `unit_column` names a row column giving each
    value's unit (`age_unit`): `unit_factors` multiplies a value into the
    field's base unit by it, then `unit_offsets` adds to it (years AD to
    years BP: factor -1, offset 1950); a unit without a factor leaves the
    record uncolored. Without factors of its own it takes those of the
    `search.unit_conversions` entry for its unit column and field. `log`
    spaces the colors by order of magnitude. `levels`, when set, restricts it
    to those search levels.
    """

    label: str
    field: str
    unit: str | None = None
    scale: float = 1.0
    log: bool = False
    unit_column: str | None = None
    unit_factors: dict[str, float] = {}
    unit_offsets: dict[str, float] = {}
    levels: list[str] = []

    @model_validator(mode="after")
    def _check_field(self) -> "MapColor":
        if "." in self.field and not self.field.startswith("summary."):
            raise ValueError(f"map color field {self.field!r} must be a column or a summary.* path")
        if self.unit_column and "." in self.field:
            raise ValueError(f"map color {self.field!r}: unit_column needs a column field")
        return self

    def path(self, table: str) -> str:
        """Its document path at a search level."""
        return self.field if "." in self.field else f"summary.{table}.{self.field}"


def number(value: Any) -> float | None:
    """A cell's value as a finite number, or None (blank, text, NaN)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


class UnitConversion(BaseModel):
    """Number columns whose unit is another column of the row (`age` in its
    `age_unit`), put in one base unit (`unit`: years BP) in `summary._num` so
    values in different units compare. A value in `columns` is multiplied by
    its unit's factor and its offset added (years AD -> BP: factor -1, offset
    1950); one in `scaled` (an uncertainty) only by the factor's size. A
    negative factor reverses order, so the `bounds` pair (low, high) swaps. A
    unit without a factor leaves the row's values out."""

    unit_column: str
    columns: list[str]
    scaled: list[str] = []
    bounds: tuple[str, str] | None = None
    unit: str | None = None
    factors: dict[str, float]
    offsets: dict[str, float] = {}

    @model_validator(mode="after")
    def _check_bounds(self) -> "UnitConversion":
        if self.bounds and not set(self.bounds) <= set(self.columns):
            raise ValueError(f"unit conversion bounds {list(self.bounds)} must be in its columns")
        return self

    @property
    def all_columns(self) -> list[str]:
        return [*self.columns, *self.scaled]

    def convert(self, row: dict) -> dict[str, float]:
        """A row's values of these columns in the base unit (none without a
        known unit)."""
        unit = str(row.get(self.unit_column) or "").strip()
        factor = self.factors.get(unit)
        if factor is None:
            return {}
        offset = self.offsets.get(unit, 0.0)
        out: dict[str, float] = {}
        for column in self.all_columns:
            if (value := number(row.get(column))) is not None:
                out[column] = (
                    value * factor + offset if column in self.columns else value * abs(factor)
                )
        if factor < 0 and self.bounds and all(c in out for c in self.bounds):
            low, high = self.bounds
            out[low], out[high] = out[high], out[low]
        return out


class BodiesConfig(BaseModel):
    """Rows positioned on another planetary body: those whose `column` holds
    one of `values` (location_type "Lunar" -> moon), and the rows below them
    (a lunar location's sites, samples, ...). Their positions are
    `summary._all._body_point` ({lat, lon, body}) instead of `_geo_point`, so
    Earth's area filters and maps leave them out and the maps and thumbnails
    draw them on that body."""

    column: str
    values: dict[str, Body]

    def body_of(self, row: dict) -> Body | None:
        """The body a row's `column` names (the first of a colon-delimited list)."""
        value = row.get(self.column)
        if value in (None, ""):
            return None
        return next(
            (self.values[v.strip()] for v in str(value).split(":") if v.strip() in self.values),
            None,
        )


class GeographyConfig(BaseModel):
    """A record's geography: columns (geologic units, then geographic names)
    that a record below inherits from the records above it that it names (a
    specimen shows and filters on its site's location and that location's
    country, as the legacy summaries did), and that the grid's Geography tile
    lists, filters and facets on."""

    geologic: list[str] = []
    geographic: list[str] = []

    @property
    def columns(self) -> list[str]:
        return [*self.geologic, *self.geographic]


class SearchConfig(BaseModel):
    index: str
    levels: list[SearchLevel]
    extra_types: list[str] = []
    filters: list[SearchFilter] = []
    # What the search map can color its markers by, in menu order.
    map_colors: list[MapColor] = []
    bodies: BodiesConfig | None = None
    # Number columns put in one unit in summary._num (ages in years BP).
    unit_conversions: list[UnitConversion] = []
    geography: GeographyConfig = GeographyConfig()
    # The search box's example query.
    placeholder: str = 'e.g. keyword "exact phrase" -excluded'

    @model_validator(mode="after")
    def _map_color_units(self) -> "SearchConfig":
        """A map color with a unit column and no factors of its own takes its
        unit conversion's."""
        colors = []
        for color in self.map_colors:
            if color.unit_column and not color.unit_factors:
                conversion = self.conversion(color.unit_column, color.field)
                if conversion is None:
                    raise ValueError(
                        f"map color {color.field!r}: unit_column needs unit_factors or a "
                        f"unit_conversions entry for {color.unit_column!r} and {color.field!r}"
                    )
                color = color.model_copy(
                    update={"unit_factors": conversion.factors, "unit_offsets": conversion.offsets}
                )
            colors.append(color)
        self.map_colors = colors
        return self

    def conversion(self, unit_column: str, column: str) -> UnitConversion | None:
        return next(
            (
                c
                for c in self.unit_conversions
                if c.unit_column == unit_column and column in c.all_columns
            ),
            None,
        )

    @model_validator(mode="before")
    @classmethod
    def _facets_to_filters(cls, raw: Any) -> Any:
        """`facets: [column, ...]` (the pre-2026-09 shape) is a list of facet
        filters; keep loading it."""
        if isinstance(raw, dict) and raw.get("facets"):
            raw = dict(raw)
            filters = list(raw.get("filters") or [])
            have = {
                f.get("field") for f in filters if isinstance(f, dict) and f.get("type") == "facet"
            }
            filters += [{"type": "facet", "field": c} for c in raw.pop("facets") if c not in have]
            raw["filters"] = filters
        return raw

    @property
    def facets(self) -> list[str]:
        """Columns aggregated as term buckets on every search."""
        return [f.field for f in self.filters if f.type == "facet" and f.field]


class PageConfig(BaseModel):
    """A content page at /<slug>, its HTML in `configurations/<node>/pages/<slug>.html`.
    The list order is the menu order."""

    slug: str
    title: str
    menu: Literal["left", "right", "hidden"] = "left"
    icon: str | None = None  # frontend icon name, shown before right-menu items

    @field_validator("slug")
    @classmethod
    def _slug(cls, value: str) -> str:
        if not PAGE_SLUG_RE.match(value) or value in RESERVED_PAGE_SLUGS:
            raise ValueError(
                f"page slug {value!r}: lowercase letters, digits and hyphens, starting with "
                f"a letter, and not one of {sorted(RESERVED_PAGE_SLUGS)}"
            )
        return value


class StorageConfig(BaseModel):
    bucket: str


class DataModelConfig(BaseModel):
    versions: list[str]
    latest: str
    dir: str


class VocabulariesConfig(BaseModel):
    controlled: str
    suggested: str | None = None


class DoiConfig(BaseModel):
    prefix: str | None = None


class PublishConfig(BaseModel):
    """Whether production serves the node. `api`: its /v2/{node}/... routes;
    `web`: its SPA at /<Key>/ and its entry in the portal bar. A local stack
    (FIESTA_ENVIRONMENT=development) serves every node either way."""

    api: bool = True
    web: bool = True

    @model_validator(mode="after")
    def _web_needs_api(self) -> "PublishConfig":
        if self.web and not self.api:
            raise ValueError("publish.web needs publish.api: the web app reads the node's API")
        return self


class WorkspaceField(BaseModel):
    """A column of the workspace table a private contribution's card edits.
    Its control follows the data model: a `List` column is a multi-select
    (over its `cv(...)` vocabulary when it has one), a `Dictionary` column is
    rows of title + URL (`title[url]` cells joined by `;`), anything else is a
    text input. `required()` columns are marked until they are filled."""

    column: str
    label: str | None = None  # default: the data model's label
    placeholder: str | None = None


class WorkspaceConfig(BaseModel):
    """The private workspace's per-node options (legacy MagIC
    private_contributions.jsx: Labs, Funding, Supplement, Description)."""

    table: str = "contribution"
    fields: list[WorkspaceField] = []
    # Publish waits until the reference DOI resolves at Crossref or DataCite.
    require_reference: bool = False


class UploadExample(BaseModel):
    """An example file the upload page offers to import or download (legacy
    MagIC upload_contribution.jsx "Example" cards). `file` is relative to
    configurations/<slug>/assets/."""

    title: str  # "\n" breaks the title onto two lines
    subtitle: str = ""
    file: str
    format: Literal["fiesta", "tsv", "csv", "excel"]
    icon: str = "file-text"


class ExcelTemplate(BaseModel):
    """A spreadsheet layout the import step recognises: a sheet whose cells
    match every `markers` regex (cell address -> pattern, e.g. MagIC's
    {A1: "Group:", A4: "Column:"}) has its first `skip_rows` rows and
    `skip_columns` columns dropped before the column header row."""

    markers: dict[str, str]
    skip_rows: int = Field(0, ge=0)
    skip_columns: int = Field(0, ge=0)

    @field_validator("markers")
    @classmethod
    def _cells(cls, value: dict[str, str]) -> dict[str, str]:
        if not value:
            raise ValueError("an Excel template needs at least one marker cell")
        for cell, pattern in value.items():
            if not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]*", cell):
                raise ValueError(f"marker cell {cell!r} is not an A1-style address")
            try:
                re.compile(pattern)
            except re.error as exc:
                raise ValueError(f"marker {cell} pattern {pattern!r}: {exc}") from None
        return value


class UploadConfig(BaseModel):
    """The upload page's per-node options (legacy MagIC upload_contribution.jsx)."""

    examples: list[UploadExample] = []
    excel_templates: list[ExcelTemplate] = []
    # Tables one upload may bring from a single sheet only (MagIC refuses two
    # measurements tables: "Please combine them before uploading").
    single_source_tables: list[str] = []


class HomeCardConfig(BaseModel):
    """A resource card on the home page (legacy `ui nine cards` IconButton)."""

    title: str  # "\n" breaks the title onto two lines
    icon: str  # Semantic UI icon name (database, sitemap, lab, ...)
    corner_icon: str | None = None
    to: str | None = None  # SPA route, e.g. /method-codes
    href: str | None = None  # external URL

    @model_validator(mode="after")
    def _one_target(self) -> "HomeCardConfig":
        if (self.to is None) == (self.href is None):
            raise ValueError(f"home card {self.title!r} needs exactly one of to/href")
        return self


class HomeNewsConfig(BaseModel):
    """A news item in the home page's right column."""

    title: str
    html: str  # trusted markup from this repo's YAML
    image: str | None = None  # path under configurations/<slug>/assets/ or an absolute URL
    link: str | None = None  # optional URL the title links to


class HomeConfig(BaseModel):
    resources: list[HomeCardConfig] = []
    news: list[HomeNewsConfig] = []


class FeaturesConfig(BaseModel):
    plugins: list[str] = []
    home: HomeConfig = HomeConfig()


class DevelopmentConfig(BaseModel):
    seed_manifest: str | None = None


class SourceSyncConfig(BaseModel):
    """When the ops worker runs the node's `configurations/sources/<slug>.py` (data-source mode;
    docs/data-sources.md). Edited on the admin node page's Data source tab."""

    enabled: bool = False
    cron: str = "20 * * * *"  # UTC

    @field_validator("cron")
    @classmethod
    def _cron(cls, value: str) -> str:
        from croniter import croniter

        value = " ".join(value.split())
        if not croniter.is_valid(value):
            raise ValueError(f"invalid cron expression {value!r}")
        return value


class LegacySourceConfig(BaseModel):
    """Where this node's contributions live on the legacy platform.

    Read only by `fiesta legacy-inventory`, never at application startup.
    `kind: meteor` (default): the index is addressed by its literal name (no
    FIESTA_INDEX_PREFIX); buckets are tried in order for `<id>/<canonical>`;
    contributions with no object in any bucket (private workspaces) are exported
    from the indexed tables instead. `kind: earthref-cgi`: a Perl CGI archive
    read from its public record pages `<base_url>/<id>/` for ids `1..max_id`
    (fiesta.services.legacy_cgi). `kind: script`: a source only the node's own
    `configurations/sources/<slug>.py` reads (e.g. GEOMAGIA's MySQL catalogue);
    there is nothing for `legacy-inventory` to snapshot.
    """

    kind: Literal["meteor", "earthref-cgi", "script"] = "meteor"
    source_id: str
    index: str | None = None
    base_url: str | None = None  # earthref-cgi
    max_id: int = 0  # earthref-cgi: highest record id probed
    concurrency: int = 4  # earthref-cgi: parallel page/file requests (be polite)
    exclude_ids: list[int] = []  # live records left out (test or withheld records)
    # earthref-cgi: a record whose files are not all on disk (deferred by size, or
    # lost from the legacy archive). "exclude" leaves it out; "metadata" imports its
    # text alone, each `files` row noting why its file is not attached.
    incomplete_records: Literal["exclude", "metadata"] = "exclude"
    buckets: list[str] = []
    users_index: str = "er_users"
    canonical: str = "{slug}_contribution_{id}.txt"
    max_file_bytes: int = 2 * 1024**3  # larger objects are reported, not imported in memory
    # The node data model version every legacy record is imported as, replacing
    # the version the legacy summary (and an index-exported contribution table)
    # carries; for a legacy index whose version has no FIESTA model. None keeps
    # the legacy version when the node has it, else the latest.
    data_model_version: str | None = None
    # Operator-supplied owner for contributions whose legacy record has no usable
    # contributor handle (bulk loads). Keyed by contribution id; the email must resolve
    # to an er_users account (name/ORCID verified) or be declared in `owner_accounts`.
    owner_overrides: dict[int, str] = {}
    # Operator-approved mapping of a legacy display name (`_contributor`) to an
    # account email, for bulk-loaded records that carry no handle at all.
    owner_names: dict[str, str] = {}
    # Operator-approved mapping of a legacy contributor handle that is not an
    # account (e.g. a bulk loader's shared handle) to an account email; applies to
    # private records too.
    owner_handles: dict[str, str] = {}
    # Operator-designated steward account for published records that still have no
    # owner after the maps above (never applied to private contributions).
    default_owner: str | None = None
    # Operator-declared accounts for mapped emails that have no er_users account (a
    # steward address that never used the legacy apps): email -> {name, orcid}. Such
    # an owner is created on the target without a password, with this name.
    owner_accounts: dict[str, dict[str, str]] = {}
    # The scheduled sync of this source into a data-source-mode node.
    sync: SourceSyncConfig = Field(default_factory=SourceSyncConfig)

    @model_validator(mode="after")
    def _check_kind(self) -> "LegacySourceConfig":
        if self.kind == "meteor" and not self.index:
            raise ValueError("legacy.kind meteor needs legacy.index")
        if self.kind == "earthref-cgi" and not (self.base_url and self.max_id > 0):
            raise ValueError("legacy.kind earthref-cgi needs legacy.base_url and legacy.max_id")
        return self

    OWNER_FIELDS: ClassVar[tuple[str, ...]] = (
        "owner_overrides",
        "owner_names",
        "owner_handles",
        "default_owner",
        "owner_accounts",
    )

    def with_owner_map(self, owner_map: dict) -> "LegacySourceConfig":
        """A copy with the operator's owner mapping (any of `OWNER_FIELDS`) merged
        over this block: map fields merge key by key, `default_owner` replaces.

        Owner mappings name accounts by email, so they live in a gitignored
        per-run file (`legacy-inventory --owner-map`), never in the node YAML.
        """
        unknown = sorted(set(owner_map) - set(self.OWNER_FIELDS))
        if unknown:
            raise ValueError(f"owner map: unknown fields {unknown}; allowed {self.OWNER_FIELDS}")
        merged = self.model_dump()
        for name, value in owner_map.items():
            if isinstance(merged[name], dict):
                if not isinstance(value, dict):
                    raise ValueError(f"owner map: {name} must be an object")
                merged[name] = {**merged[name], **value}
            else:
                merged[name] = value
        return LegacySourceConfig.model_validate(merged)


class NodeConfig(BaseModel):
    """A single FIESTA node, fully described."""

    node: NodeIdentity
    search: SearchConfig
    storage: StorageConfig
    data_model: DataModelConfig
    vocabularies: VocabulariesConfig
    hierarchy: list[str]
    doi: DoiConfig = DoiConfig()
    pages: list[PageConfig] = []
    features: FeaturesConfig = FeaturesConfig()
    publish: PublishConfig = PublishConfig()
    workspace: WorkspaceConfig = WorkspaceConfig()
    upload: UploadConfig = UploadConfig()
    # Per-plugin options, keyed by plugin name, validated against each
    # plugin's Options model by fiesta.plugins.active_plugins.
    plugins: dict[str, dict[str, Any]] = {}
    development: DevelopmentConfig = DevelopmentConfig()
    legacy: LegacySourceConfig | None = None

    # Directory the YAML was loaded from; asset paths resolve against it.
    base_dir: Path

    # JSON assets are large (data models, vocabularies) — cache per instance.
    _asset_cache: dict = PrivateAttr(default_factory=dict)

    @model_validator(mode="after")
    def _check_hierarchy(self) -> "NodeConfig":
        if self.data_model.latest not in self.data_model.versions:
            raise ValueError("data_model.latest must be one of data_model.versions")
        legacy_version = self.legacy.data_model_version if self.legacy else None
        if legacy_version and legacy_version not in self.data_model.versions:
            raise ValueError("legacy.data_model_version must be one of data_model.versions")
        model_tables = self.load_data_model(self.data_model.latest)["tables"]
        tables = set(model_tables)
        missing = [t for t in self.hierarchy if t not in tables]
        if missing:
            raise ValueError(f"hierarchy tables missing from data model: {missing}")
        bodies = self.search.bodies
        if bodies and not any(
            bodies.column in model_tables[t].get("columns", {}) for t in self.hierarchy
        ):
            raise ValueError(f"search.bodies column {bodies.column!r} is in no hierarchy table")
        self._check_grid_columns()
        if self.workspace.fields:
            columns = model_tables.get(self.workspace.table, {}).get("columns")
            if columns is None:
                raise ValueError(
                    f"workspace.table {self.workspace.table!r} is not in the data model"
                )
            named = [f.column for f in self.workspace.fields]
            if missing := [c for c in named if c not in columns]:
                raise ValueError(
                    f"workspace.fields name columns {missing} "
                    f"the {self.workspace.table} table does not have"
                )
        if missing := [t for t in self.upload.single_source_tables if t not in tables]:
            raise ValueError(f"upload.single_source_tables {missing} are not in the data model")
        if missing := [e.file for e in self.upload.examples if self.asset_path(e.file) is None]:
            raise ValueError(f"upload.examples files {missing} are not in {self.node.slug}/assets/")
        slugs = [p.slug for p in self.pages]
        if len(set(slugs)) != len(slugs):
            raise ValueError(
                f"duplicate page slugs: {sorted({s for s in slugs if slugs.count(s) > 1})}"
            )
        return self

    def _check_grid_columns(self) -> None:
        # A grid column naming a column its level's table does not have would
        # show an empty cell forever: catch the typo before publishing. A
        # record's `values` also hold the geography of the records above it,
        # and a contribution's `values` / `range` every table's; a `range`
        # needs a number column.
        tables = self.load_data_model(self.data_model.latest)["tables"]
        every = {k: v for t in tables.values() for k, v in t.get("columns", {}).items()}
        geography = {g: every.get(g, {}) for g in self.search.geography.columns}
        for level in self.search.levels:
            columns = tables.get(level.table, {}).get("columns")
            if columns is None:
                continue
            for col in level.columns or []:
                show = col.show or "value"
                known = columns
                if show != "value" and level.table == "contribution":
                    known = every
                elif show == "values":
                    known = {**geography, **columns}
                if missing := [n for n in col.data_columns if n not in known]:
                    raise ValueError(
                        f"search level {level.name!r} grid names columns {missing} "
                        f"the {level.table} table does not have"
                    )
                numbers = ("Number", "Integer")
                text = [n for n in col.data_columns if known[n].get("type") not in numbers]
                if show == "range" and text:
                    raise ValueError(
                        f"search level {level.name!r} grid shows a range of "
                        f"columns {text}, which are not numbers"
                    )

    def _load_json(self, rel: str) -> Any:
        if rel not in self._asset_cache:
            self._asset_cache[rel] = json.loads((self.base_dir / rel).read_text())
        return self._asset_cache[rel]

    def page(self, slug: str) -> PageConfig | None:
        return next((p for p in self.pages if p.slug == slug), None)

    def page_path(self, slug: str) -> str:
        """Tree path of a page's HTML, relative to the config directory."""
        return f"{self.node.slug}/pages/{slug}.html"

    def load_page_html(self, slug: str) -> str:
        """The page's HTML as authored (sanitized by the SPA on render)."""
        if self.page(slug) is None:
            raise KeyError(slug)
        path = self.base_dir / self.page_path(slug)
        return path.read_text() if path.is_file() else ""

    def asset_path(self, rel: str) -> Path | None:
        """Resolve `configurations/<slug>/assets/<rel>`; None if outside that dir or missing."""
        root = (self.base_dir / self.node.slug / "assets").resolve()
        candidate = (root / rel).resolve()
        if root not in candidate.parents or not candidate.is_file():
            return None
        return candidate

    def load_data_model(self, version: str) -> dict:
        if version not in self.data_model.versions:
            raise KeyError(f"unknown data model version {version!r}")
        return self._load_json(f"{self.data_model.dir}/{version}.json")

    def load_controlled_vocabularies(self) -> dict:
        return self._load_json(self.vocabularies.controlled)

    def load_suggested_vocabularies(self) -> dict:
        if not self.vocabularies.suggested:
            return {}
        return self._load_json(self.vocabularies.suggested)

    @property
    def geo_tables(self) -> set[str]:
        """Hierarchy tables whose rows can carry a position: a latitude and a
        longitude column in the latest data model, or the key column of a
        table above that has one (a specimen's `sample`: the summarizer gives
        it its sample's position); the contribution too when any does, as its
        search doc takes their points."""
        tables = self.load_data_model(self.data_model.latest)["tables"]
        geo: set[str] = set()
        for table in self.hierarchy:
            columns = tables.get(table, {}).get("columns", {})
            if (
                any(c in columns for c in LAT_COLUMNS) and any(c in columns for c in LON_COLUMNS)
            ) or any(parent.removesuffix("s") in columns for parent in geo):
                geo.add(table)
        return geo | {"contribution"} if geo else geo

    @property
    def area_tables(self) -> set[str]:
        """Hierarchy tables whose rows are areas (a lat_s/lat_n/lon_w/lon_e box
        in the latest data model): the summarizer maps each at the positions
        of the rows below it, so its docs are many points, never aggregated."""
        tables = self.load_data_model(self.data_model.latest)["tables"]
        return {
            table
            for table in self.hierarchy
            if all(c in tables.get(table, {}).get("columns", {}) for c in BOX_COLUMNS)
        }

    def number_columns(self, table: str) -> list[str]:
        """The columns of a hierarchy table indexed as numbers in its docs'
        `summary._num` (the latest data model's NUMBER_TYPES, ids left out);
        the contribution's are every level's, as its doc unions them."""
        tables = self.load_data_model(self.data_model.latest)["tables"]
        levels = self.hierarchy[1:] if table == self.hierarchy[0] else [table]
        out: dict[str, None] = {}
        for level in levels:
            for column, definition in tables.get(level, {}).get("columns", {}).items():
                if definition.get("type") in NUMBER_TYPES and column not in NUMBER_ID_COLUMNS:
                    out.setdefault(column)
        return list(out)

    def text_columns(self, table: str) -> list[str]:
        """The text columns (TEXT_TYPES, ids and download-only ones left out)
        of a hierarchy table whose values its docs' `summary._all` holds, in
        position order: the `text` filter's facets. The contribution's are
        every level's, as its doc unions them."""
        tables = self.load_data_model(self.data_model.latest)["tables"]
        levels = self.hierarchy[1:] if table == self.hierarchy[0] else [table]
        out: dict[str, None] = {}
        for level in levels:
            columns = tables.get(level, {}).get("columns", {})
            for column, definition in sorted(
                columns.items(), key=lambda item: item[1].get("position", 0)
            ):
                if (
                    definition.get("type") in TEXT_TYPES
                    and column not in NUMBER_ID_COLUMNS
                    and "downloadOnly()" not in (definition.get("validations") or [])
                ):
                    out.setdefault(column)
        return list(out)

    def exists_tables(self, table: str) -> list[str]:
        """The tables whose columns with data a search table's docs record in
        `summary._has.<table>` (the with/without data filter's tabs), in
        data-model order: the contribution's every data-model table but its
        own; a hierarchy level's its own and the levels below it (a record
        takes its descendants', a location its sites' and theirs). ANY_TABLE
        (their union) leads when there are several; none for other tables."""
        tables = self.load_data_model(self.data_model.latest)["tables"]
        top, levels = self.hierarchy[0], self.hierarchy[1:]
        if table == top:
            ordered = sorted(tables, key=lambda t: tables[t].get("position", 0))
            found = [t for t in ordered if t != top]
        elif table in levels:
            found = [t for t in levels[levels.index(table) :] if t in tables]
        else:
            return []
        return [ANY_TABLE, *found] if len(found) > 1 else found

    def exists_columns(self, table: str, search_table: str | None = None) -> list[str]:
        """A data-model table's columns the with/without data filter lists, in
        position order, those only for download (`downloadOnly()`, the row
        stamps) left out. ANY_TABLE's: those of `search_table`'s tables."""
        if table == ANY_TABLE:
            out: dict[str, None] = {}
            for tab in self.exists_tables(search_table or self.hierarchy[0]):
                if tab != ANY_TABLE:
                    out.update(dict.fromkeys(self.exists_columns(tab)))
            return list(out)
        tables = self.load_data_model(self.data_model.latest)["tables"]
        columns = tables.get(table, {}).get("columns", {})
        return [
            column
            for column, definition in sorted(
                columns.items(), key=lambda item: item[1].get("position", 0)
            )
            if "downloadOnly()" not in (definition.get("validations") or [])
        ]

    def map_color_tables(self, color: MapColor) -> list[str]:
        """The search levels' tables whose map `color` can color: levels with
        positions, those it names, and for a column those whose table has it."""
        geo, tables = self.geo_tables, None
        if "." not in color.field:
            tables = self.load_data_model(self.data_model.latest)["tables"]
        return [
            level.table
            for level in self.search.levels
            if level.table in geo
            and (not color.levels or level.name in color.levels)
            and (tables is None or color.field in tables.get(level.table, {}).get("columns", {}))
        ]

    def map_color(self, table: str, field: str) -> MapColor | None:
        """The map color `field` at a level, if it is offered there."""
        return next(
            (
                c
                for c in self.search.map_colors
                if c.field == field and table in self.map_color_tables(c)
            ),
            None,
        )

    # --- names resolved against the environment (fiesta.settings) ---------

    @property
    def search_index(self) -> str:
        """OpenSearch index for this node: FIESTA_INDEX_PREFIX + search.index."""
        return f"{get_settings().index_prefix}{self.search.index}"

    @property
    def bucket(self) -> str:
        """Bucket holding this node's objects: FIESTA_S3_BUCKET if set (one
        shared bucket, keys under storage_prefix), else the YAML bucket."""
        return get_settings().s3_bucket or self.storage.bucket

    @property
    def serves_api(self) -> bool:
        """/v2/{node}/... is served: published, or on a local stack."""
        return self.publish.api or get_settings().environment == "development"

    @property
    def serves_web(self) -> bool:
        """The SPA opens and the portal bar lists the node: published, or on a local stack."""
        return self.publish.web or get_settings().environment == "development"

    @property
    def contributions_mode(self) -> str:
        """ "public" (people contribute here) or "source" (synced from its data
        source) in this deployment: FIESTA_CONTRIBUTIONS_MODE, else the
        deployment file's `api.contributions_mode`, else public."""
        from fiesta.settings import parse_contributions_mode

        value = get_settings().contributions_mode or get_deployment().contributions_mode
        default, nodes = parse_contributions_mode(value)
        return nodes.get(self.node.slug.lower(), default)

    @property
    def source_script(self) -> Path | None:
        """This node's data-source sync script, `configurations/sources/<slug>.py`, if the
        checkout has one."""
        script = get_settings().sources_path / f"{self.node.slug}.py"
        return script if script.is_file() else None

    @property
    def storage_prefix(self) -> str:
        """Key prefix inside the bucket: "<slug>/" in a shared bucket, else ""."""
        return f"{self.node.slug}/" if get_settings().s3_bucket else ""

    def public_level(self, level: SearchLevel) -> dict:
        """A search level as the SPA sees it: its grid columns resolved."""
        from fiesta.search.grid import public_columns

        return {
            **level.model_dump(exclude={"columns"}),
            "geo": level.table in self.geo_tables,
            "columns": public_columns(self, level),
        }

    def public_config(self) -> dict:
        """The shape served at GET /api/config for the frontend."""
        return {
            "key": self.node.key,
            "slug": self.node.slug,
            "title": self.node.title,
            "subtitle": self.node.subtitle,
            "color": self.node.color,
            "logo": self.node.logo,
            "links": self.node.links.model_dump(),
            "data_model_versions": self.data_model.versions,
            "data_model_latest": self.data_model.latest,
            "search_levels": [self.public_level(lvl) for lvl in self.search.levels],
            "facets": self.search.facets,
            "filters": [f.model_dump() for f in self.search.filters],
            # The base unit of the summary._num columns a unit conversion puts
            # in one ({"age": "years BP"}), for the numeric filter's picker.
            "number_units": {
                column: c.unit
                for c in self.search.unit_conversions
                if c.unit
                for column in c.all_columns
            },
            # The with/without data filter's tabs per search table (ANY_TABLE
            # first when there are several), for levels that record any.
            "exists_tables": {
                level.table: tabs
                for level in self.search.levels
                if (tabs := self.exists_tables(level.table))
            },
            # `tables`: the levels (by table) each is offered on.
            "map_colors": [
                {
                    **c.model_dump(include={"label", "field", "unit", "scale", "log"}),
                    "tables": self.map_color_tables(c),
                }
                for c in self.search.map_colors
            ],
            # The planetary bodies besides Earth its records can be on.
            "bodies": sorted(set(self.search.bodies.values.values())) if self.search.bodies else [],
            "pages": [p.model_dump() for p in self.pages],
            "features": self.features.model_dump(),
            "publish": self.publish.model_dump(),
            "web_published": self.serves_web,
            # "source": contributions are made at the data source (links.website
            # until the cutover) and synced here; the SPA offers no upload.
            "contributions_mode": self.contributions_mode,
            "doi_prefix": self.doi.prefix,
            # The Geography tile's columns and the search box's example query.
            "geography": self.search.geography.model_dump(),
            "search_placeholder": self.search.placeholder,
            "workspace": {
                "fields": self.workspace_fields(),
                "require_reference": self.workspace.require_reference,
            },
            "upload": self.upload.model_dump(),
        }

    def workspace_fields(self) -> list[dict]:
        """`workspace.fields` with each column's control resolved from the
        latest data model: kind (list | links | text), vocabulary, required."""
        columns = (
            self.load_data_model(self.data_model.latest)["tables"]
            .get(self.workspace.table, {})
            .get("columns", {})
        )
        resolved = []
        for field in self.workspace.fields:
            column = columns.get(field.column, {})
            validations = column.get("validations") or []
            kind = {"List": "list", "Dictionary": "links"}.get(column.get("type"), "text")
            vocabulary = next(
                (v[len('cv("') : -2] for v in validations if v.startswith('cv("')), None
            )
            resolved.append(
                {
                    "column": field.column,
                    "label": field.label or column.get("label") or field.column,
                    "placeholder": field.placeholder,
                    "kind": kind,
                    "vocabulary": vocabulary,
                    "required": "required()" in validations,
                }
            )
        return resolved

    model_config = {"frozen": True, "arbitrary_types_allowed": True}


class Deployment(BaseModel):
    """Every node one FIESTA process serves (`configurations/fiesta.yaml`), keyed by
    lowercase node key. FIESTA_NODE narrows the list for a local stack."""

    title: str = "EarthRef FIESTA API"
    nodes: dict[str, NodeConfig]
    # `api.contributions_mode` (FIESTA_CONTRIBUTIONS_MODE overrides it).
    contributions_mode: str = "public"

    def node_for(self, repository: str) -> NodeConfig:
        """Resolve the `{repository}` path segment: node key or slug, any case."""
        wanted = repository.lower()
        for key, node in self.nodes.items():
            if wanted in (key, node.node.slug.lower()):
                return node
        raise KeyError(f"unknown repository {repository!r}")

    @property
    def node_list(self) -> list[NodeConfig]:
        return list(self.nodes.values())

    model_config = {"frozen": True}


def load_node_yaml(path: Path) -> NodeConfig:
    raw = yaml.safe_load(path.read_text())
    if raw.get("deployment") != "node":
        raise ValueError(f"{path} is not a node config")
    raw.pop("fiesta", None)
    raw.pop("deployment", None)
    return NodeConfig(base_dir=path.parent, **raw)


def load_deployment(path: Path | None = None, only: list[str] | None = None) -> Deployment:
    """Load `deployment: api` (a title plus the node YAMLs it serves) or, for
    convenience, a single node YAML as a one-node deployment. `only` keeps
    just the named nodes (keys or slugs, any case)."""
    path = (path or get_settings().config_file).resolve()
    raw = yaml.safe_load(path.read_text())
    if raw.get("fiesta") != 1:
        raise ValueError(f"{path}: unsupported or missing `fiesta` config version")
    mode = raw.get("deployment")
    if mode == "node":
        node = load_node_yaml(path)
        return Deployment(title=f"FIESTA — {node.node.title}", nodes={node.node.key.lower(): node})
    if mode != "api":
        raise ValueError(f"{path}: unknown deployment mode {mode!r}")
    api = raw["api"]
    nodes: dict[str, NodeConfig] = {}
    for ref in api["nodes"]:
        node = load_node_yaml((path.parent / ref).resolve())
        nodes[node.node.key.lower()] = node
    wanted = {name.strip().lower() for name in only or () if name.strip()}
    if wanted:
        known = {k for k in nodes} | {n.node.slug.lower() for n in nodes.values()}
        if unknown := wanted - known:
            raise ValueError(f"{path}: FIESTA_NODE names unknown node(s) {sorted(unknown)}")
        nodes = {k: n for k, n in nodes.items() if k in wanted or n.node.slug.lower() in wanted}
    return Deployment(
        title=api.get("title", "EarthRef FIESTA API"),
        contributions_mode=api.get("contributions_mode") or "public",
        nodes=nodes,
    )


_current: Deployment | None = None


def get_deployment() -> Deployment:
    """The process-wide deployment: FIESTA_CONFIG_FILE filtered by FIESTA_NODE,
    with each node's published revision from Postgres swapped in once
    `fiesta.services.node_config.refresh_deployment` has run (API startup,
    worker tasks). Until then, and without a database, the YAML files."""
    global _current
    if _current is None:
        _current = load_deployment(only=get_settings().node.split(","))
    return _current


def set_deployment(deployment: Deployment | None) -> None:
    """Replace the process-wide deployment (None: reload the YAML next time)."""
    global _current
    _current = deployment


get_deployment.cache_clear = lambda: set_deployment(None)  # type: ignore[attr-defined]
