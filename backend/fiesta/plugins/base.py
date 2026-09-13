"""Plugin protocol.

Hooks are all optional — a plugin overrides only what it needs. The core
never special-cases a node: everything node-specific flows through these
hooks, keyed off the node YAML's `features.plugins` list.
"""

from fastapi import APIRouter

from fiesta.domain.parse import ParsedContribution
from fiesta.nodeconfig import NodeConfig, SearchLevel


class FiestaPlugin:
    #: Registry key; must match the name used in node YAMLs and the frontend
    #: plugin registry.
    name: str = ""

    def derive_docs(
        self, node: NodeConfig, parsed: ParsedContribution, contribution_meta: dict
    ) -> list[dict]:
        """Extra search documents derived from a contribution at summarize
        time (same shape as fiesta.domain.summarize docs: {type, summary,
        rows?}). Re-runs whenever the contribution is (re)processed and on
        `fiesta rebuild`, so derived data is always reproducible."""
        return []

    def search_levels(self, node: NodeConfig) -> list[SearchLevel]:
        """Extra top-level search tabs. Appended after the node's configured
        levels; the level's `table` should match the `type` of the docs this
        plugin derives."""
        return []

    def search_tables(self, node: NodeConfig) -> list[str]:
        """Extra searchable doc `type`s that are NOT top-level tabs — e.g.
        the `poles` docs surfaced as a sub-tab of the Locations level. These
        become valid `/api/search/{table}` targets without adding a tab."""
        return []

    def build_router(self) -> APIRouter | None:
        """Extra API routes, mounted at /v1/{repository}/plugins/{plugin.name} and
        served only for nodes that activate this plugin; handlers take NodeDep."""
        return None

    def frontend_config(self, node: NodeConfig) -> dict:
        """Arbitrary JSON surfaced to the SPA via GET /api/config under
        `plugins[name]` — the UI plugin reads its options from here."""
        return {}
