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
from typing import Any, Literal

import yaml
from pydantic import BaseModel, PrivateAttr, field_validator, model_validator

from fiesta.settings import get_settings

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
    links: NodeLinks = NodeLinks()
    contact_email: str | None = None


class SearchLevel(BaseModel):
    name: str
    table: str
    count_field: str | None = None


class SearchFilter(BaseModel):
    """One control in the search page's filter sidebar.

    `facet`: term buckets of a data-model column, aggregated on
    `summary._all.<field>.raw` and toggled as `field:"value"` query tokens.
    `range`: a numeric min/max on a full document path (e.g. `summary.poles.age`,
    a field a plugin indexes as a number; plain row values are text). `scale`
    multiplies the typed value before it is sent (Ma -> years). `bbox`: the
    lat/lon box on `summary._all._geo_point`.
    `levels` / `views` restrict where the control shows: search level names and
    result sub-tab names (Summaries, Rows, a plugin tab); empty means everywhere.
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


class SearchConfig(BaseModel):
    index: str
    levels: list[SearchLevel]
    extra_types: list[str] = []
    filters: list[SearchFilter] = []

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
    """Where this node's contributions live on the legacy Meteor platform.

    Read only by `fiesta legacy-inventory`, never at application startup. The
    index is addressed by its literal name (no FIESTA_INDEX_PREFIX); buckets are
    tried in order for `<id>/<canonical>`; contributions with no object in any
    bucket (private workspaces) are exported from the indexed tables instead.
    """

    source_id: str
    index: str
    buckets: list[str] = []
    users_index: str = "er_users"
    canonical: str = "{slug}_contribution_{id}.txt"
    max_file_bytes: int = 2 * 1024**3  # larger objects are reported, not imported in memory
    # Operator-supplied owner for contributions whose legacy record has no usable
    # contributor handle (bulk loads). Keyed by contribution id; the email must still
    # resolve to an er_users account so name/ORCID are verified, never typed in.
    owner_overrides: dict[int, str] = {}
    # Operator-approved mapping of a legacy display name (`_contributor`) to an
    # account email, for bulk-loaded records that carry no handle at all.
    owner_names: dict[str, str] = {}
    # Operator-designated steward account for published records that still have no
    # owner after the maps above (never applied to private contributions).
    default_owner: str | None = None


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
        tables = set(self.load_data_model(self.data_model.latest)["tables"])
        missing = [t for t in self.hierarchy if t not in tables]
        if missing:
            raise ValueError(f"hierarchy tables missing from data model: {missing}")
        slugs = [p.slug for p in self.pages]
        if len(set(slugs)) != len(slugs):
            raise ValueError(
                f"duplicate page slugs: {sorted({s for s in slugs if slugs.count(s) > 1})}"
            )
        return self

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
    def storage_prefix(self) -> str:
        """Key prefix inside the bucket: "<slug>/" in a shared bucket, else ""."""
        return f"{self.node.slug}/" if get_settings().s3_bucket else ""

    def public_config(self) -> dict:
        """The shape served at GET /api/config for the frontend."""
        return {
            "key": self.node.key,
            "slug": self.node.slug,
            "title": self.node.title,
            "subtitle": self.node.subtitle,
            "color": self.node.color,
            "links": self.node.links.model_dump(),
            "contact_email": self.node.contact_email,
            "data_model_versions": self.data_model.versions,
            "data_model_latest": self.data_model.latest,
            "search_levels": [lvl.model_dump() for lvl in self.search.levels],
            "facets": self.search.facets,
            "filters": [f.model_dump() for f in self.search.filters],
            "pages": [p.model_dump() for p in self.pages],
            "features": self.features.model_dump(),
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
