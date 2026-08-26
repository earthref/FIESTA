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
        """Extra search tabs (e.g. a Poles tab). Appended after the node's
        configured levels; the level's `table` should match the `type` of the
        docs this plugin derives."""
        return []

    def build_router(self, node: NodeConfig) -> APIRouter | None:
        """Extra API routes, mounted under /api/plugins/{plugin.name}."""
        return None

    def frontend_config(self, node: NodeConfig) -> dict:
        """Arbitrary JSON surfaced to the SPA via GET /api/config under
        `plugins[name]` — the UI plugin reads its options from here."""
        return {}
