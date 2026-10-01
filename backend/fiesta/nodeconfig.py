"""Deployment configuration loader.

A FIESTA deployment is `config/fiesta.yaml`: the node YAMLs (MagIC, CDR,
KArAr, ...) one API process serves. Each node YAML fully describes that node;
a node YAML also loads on its own as a one-node deployment. Large assets
(data models, controlled vocabularies) are JSON files referenced from the
YAML, resolved relative to the YAML file's directory.
"""

import json
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
# Planetary bodies other than Earth that a row's position can be on, which the
# maps and thumbnails have a basemap for (frontend/src/components/map/bodies.ts).
Body = Literal["moon", "mars"]

PAGE_SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
# SPA routes a content page can never shadow (frontend/src/router.tsx).
RESERVED_PAGE_SLUGS = {
    "search",
    "contribution",
    "contributions",
    "upload",
    "private",
    "validate",
    "data-models",
    "vocabularies",
    "method-codes",
    "login",
    "contact",
    "admin",
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
    logo: str | None = None  # path under config/<slug>/assets/ (the portal home's node cards)
    links: NodeLinks = NodeLinks()


GridCell = Literal[
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
    "geology",
    "age",
    "intensity",
    "method_codes",
    "citations",
    "field",
    "title",
]


class GridColumn(BaseModel):
    """One column of a search level's summary grid.

    `cell` names the tile the column shows: a built-in summary tile (record,
    which stacks citation, name and contributed in one column; citation, name,
    contributed, download, links, counts, map, plot, geo, geology, age,
    intensity, method_codes, citations), `field` (one column of the level's
    summary block, "Label: value") or `title` (a column in bold over an optional
    `subtitle_column`). Each tile has a default header label, width, sort and
    filter (fiesta.search.grid); `sortable` / `filterable` switch them off, and
    `sort_field` (a `.raw` keyword path, or with `numeric` any string path) and
    `filter_fields` (text paths) replace them.
    """

    cell: GridCell = "field"
    column: str | None = None
    subtitle_column: str | None = None
    label: str | None = None
    width: int | None = Field(default=None, ge=40)
    format: Literal["bytes"] | None = None
    sortable: bool = True
    filterable: bool = True
    sort_field: str | None = None
    numeric: bool | None = None
    filter_fields: list[str] | None = None

    @model_validator(mode="after")
    def _check(self) -> "GridColumn":
        if self.cell in ("field", "title") and not self.column:
            raise ValueError(f"a {self.cell} column needs a column")
        if self.cell not in ("field", "title") and (self.column or self.subtitle_column):
            raise ValueError(f"a {self.cell} column takes no column")
        paths = [self.sort_field or "summary.", *(self.filter_fields or [])]
        if bad := [p for p in paths if not p.startswith("summary.")]:
            raise ValueError(f"grid sort/filter fields must be summary.* paths: {bad}")
        return self

    @property
    def key(self) -> str:
        """The column's name in sort/filter requests: its data column, or its tile."""
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
    `range`: a numeric min/max on a full document path (e.g. `summary.poles.age`,
    a field a plugin indexes as a number; plain row values are text). `scale`
    multiplies the typed value before it is sent (Ma -> years). `bbox`: the
    lat/lon box on `summary._all._geo_point`.
    `levels` / `views` restrict where the control shows: search level names and
    result sub-tab names (Summaries, Rows, Map on levels with positions, a plugin
    tab); empty means everywhere.
    """

    type: Literal["facet", "range", "bbox"]
    field: str | None = None
    label: str | None = None  # facets default to the column's title in the UI
    levels: list[str] = []
    views: list[str] = []
    unit: str | None = None
    scale: float = 1.0
    min: float | None = None
    max: float | None = None

    @model_validator(mode="after")
    def _check_field(self) -> "SearchFilter":
        if self.type == "bbox":
            if self.field:
                raise ValueError("a bbox filter has no field (it uses summary._all._geo_point)")
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
    record uncolored. `log` spaces the colors by order of magnitude. `levels`, when
    set, restricts it to those search levels.
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
        if self.unit_column and ("." in self.field or not self.unit_factors):
            raise ValueError(
                f"map color {self.field!r}: unit_column needs a column field and unit_factors"
            )
        return self

    def path(self, table: str) -> str:
        """Its document path at a search level."""
        return self.field if "." in self.field else f"summary.{table}.{self.field}"


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
            (
                self.values[v.strip()]
                for v in str(value).split(":")
                if v.strip() in self.values
            ),
            None,
        )


class SearchConfig(BaseModel):
    index: str
    levels: list[SearchLevel]
    extra_types: list[str] = []
    filters: list[SearchFilter] = []
    # What the search map can color its markers by, in menu order.
    map_colors: list[MapColor] = []
    bodies: BodiesConfig | None = None

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
    """A content page at /<slug>, its HTML in `config/<node>/pages/<slug>.html`.
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
    method_codes: str | None = None


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
    image: str | None = None  # path under config/<slug>/assets/ or an absolute URL
    link: str | None = None  # optional URL the title links to


class HomeConfig(BaseModel):
    resources: list[HomeCardConfig] = []
    news: list[HomeNewsConfig] = []


class FeaturesConfig(BaseModel):
    plugins: list[str] = []
    home: HomeConfig = HomeConfig()


class DevelopmentConfig(BaseModel):
    seed_manifest: str | None = None


class LegacySourceConfig(BaseModel):
    """Where this node's contributions live on the legacy platform.

    Read only by `fiesta legacy-inventory`, never at application startup.
    `kind: meteor` (default): the index is addressed by its literal name (no
    FIESTA_INDEX_PREFIX); buckets are tried in order for `<id>/<canonical>`;
    contributions with no object in any bucket (private workspaces) are exported
    from the indexed tables instead. `kind: earthref-cgi`: a Perl CGI archive
    read from its public record pages `<base_url>/<id>/` for ids `1..max_id`
    (fiesta.services.legacy_cgi).
    """

    kind: Literal["meteor", "earthref-cgi"] = "meteor"
    source_id: str
    index: str | None = None
    base_url: str | None = None  # earthref-cgi
    max_id: int = 0  # earthref-cgi: highest record id probed
    concurrency: int = 4  # earthref-cgi: parallel page/file requests (be polite)
    exclude_ids: list[int] = []  # earthref-cgi: live records left out (test records)
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
    # contributor handle (bulk loads). Keyed by contribution id; the email must still
    # resolve to an er_users account so name/ORCID are verified, never typed in.
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
        slugs = [p.slug for p in self.pages]
        if len(set(slugs)) != len(slugs):
            raise ValueError(
                f"duplicate page slugs: {sorted({s for s in slugs if slugs.count(s) > 1})}"
            )
        return self

    def _check_grid_columns(self) -> None:
        # A grid column naming a column its level's table does not have would
        # show an empty cell forever: catch the typo before publishing.
        tables = self.load_data_model(self.data_model.latest)["tables"]
        for level in self.search.levels:
            columns = tables.get(level.table, {}).get("columns")
            if columns is None:
                continue
            named = [n for c in level.columns or [] for n in (c.column, c.subtitle_column) if n]
            if missing := [n for n in named if n not in columns]:
                raise ValueError(
                    f"search level {level.name!r} grid names columns {missing} "
                    f"the {level.table} table does not have"
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
        """Resolve `config/<slug>/assets/<rel>`; None if outside that dir or missing."""
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

    def load_method_codes(self) -> dict | None:
        if not self.vocabularies.method_codes:
            return None
        return self._load_json(self.vocabularies.method_codes)

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
            # `tables`: the levels (by table) each is offered on.
            "map_colors": [
                {
                    **c.model_dump(include={"label", "field", "unit", "scale", "log"}),
                    "tables": self.map_color_tables(c),
                }
                for c in self.search.map_colors
            ],
            "pages": [p.model_dump() for p in self.pages],
            "features": self.features.model_dump(),
            "publish": self.publish.model_dump(),
            "web_published": self.serves_web,
            "has_method_codes": self.vocabularies.method_codes is not None,
            "doi_prefix": self.doi.prefix,
        }

    model_config = {"frozen": True, "arbitrary_types_allowed": True}


class Deployment(BaseModel):
    """Every node one FIESTA process serves (`config/fiesta.yaml`), keyed by
    lowercase node key. FIESTA_NODE narrows the list for a local stack."""

    title: str = "EarthRef FIESTA API"
    nodes: dict[str, NodeConfig]

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
    return Deployment(title=api.get("title", "EarthRef FIESTA API"), nodes=nodes)


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
