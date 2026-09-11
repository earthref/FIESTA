"""Deployment configuration loader.

A FIESTA deployment is described by a single YAML file (config/*.yaml):
either one node (MagIC, CDR, KArAr, ...) or the public API spanning several
nodes. Large assets (data models, controlled vocabularies) are JSON files
referenced from the YAML, resolved relative to the YAML file's directory.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, PrivateAttr, model_validator

from fiesta.settings import get_settings


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


class SearchConfig(BaseModel):
    index: str
    levels: list[SearchLevel]
    extra_types: list[str] = []
    facets: list[str] = []


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
    pages: list[str] = []
    plugins: list[str] = []
    home: HomeConfig = HomeConfig()


class NodeConfig(BaseModel):
    """A single FIESTA node, fully described."""

    node: NodeIdentity
    search: SearchConfig
    storage: StorageConfig
    data_model: DataModelConfig
    vocabularies: VocabulariesConfig
    hierarchy: list[str]
    doi: DoiConfig = DoiConfig()
    features: FeaturesConfig = FeaturesConfig()

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
        return self

    def _load_json(self, rel: str) -> Any:
        if rel not in self._asset_cache:
            self._asset_cache[rel] = json.loads((self.base_dir / rel).read_text())
        return self._asset_cache[rel]

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
            "features": self.features.model_dump(),
            "has_method_codes": self.vocabularies.method_codes is not None,
            "doi_prefix": self.doi.prefix,
        }

    model_config = {"frozen": True, "arbitrary_types_allowed": True}


class PublicApiConfig(BaseModel):
    title: str = "EarthRef FIESTA API"
    nodes: dict[str, NodeConfig]  # keyed by lowercase node key

    def node_for(self, repository: str) -> NodeConfig:
        try:
            return self.nodes[repository.lower()]
        except KeyError:
            raise KeyError(f"unknown repository {repository!r}") from None

    model_config = {"frozen": True}


class Deployment(BaseModel):
    mode: Literal["node", "public-api"]
    node: NodeConfig | None = None
    public_api: PublicApiConfig | None = None

    model_config = {"frozen": True}


def _load_node_yaml(path: Path) -> NodeConfig:
    raw = yaml.safe_load(path.read_text())
    if raw.get("deployment") != "node":
        raise ValueError(f"{path} is not a node config")
    raw.pop("fiesta", None)
    raw.pop("deployment", None)
    return NodeConfig(base_dir=path.parent, **raw)


def load_deployment(path: Path | None = None) -> Deployment:
    path = (path or get_settings().config_file).resolve()
    raw = yaml.safe_load(path.read_text())
    if raw.get("fiesta") != 1:
        raise ValueError(f"{path}: unsupported or missing `fiesta` config version")
    mode = raw.get("deployment")
    if mode == "node":
        return Deployment(mode="node", node=_load_node_yaml(path))
    if mode == "public-api":
        pub = raw["public_api"]
        nodes = {}
        for ref in pub["nodes"]:
            node = _load_node_yaml((path.parent / ref).resolve())
            nodes[node.node.key.lower()] = node
        return Deployment(
            mode="public-api",
            public_api=PublicApiConfig(title=pub.get("title", "EarthRef FIESTA API"), nodes=nodes),
        )
    raise ValueError(f"{path}: unknown deployment mode {mode!r}")


@lru_cache
def get_deployment() -> Deployment:
    return load_deployment()


def get_node() -> NodeConfig:
    dep = get_deployment()
    if dep.node is None:
        raise RuntimeError("this deployment is not a node (deployment: public-api)")
    return dep.node
