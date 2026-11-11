"""Plugin protocol.

Hooks are all optional — a plugin overrides only what it needs. The core
never special-cases a node: everything node-specific flows through these
hooks, keyed off the node YAML's `features.plugins` list, and everything a
plugin lets a node tune is an option declared on its `Options` model and set
in the node YAML's `plugins: {<name>: {...}}` map.
"""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ValidationError

from fiesta.domain.parse import ParsedContribution
from fiesta.nodeconfig import NodeConfig, SearchLevel


class PluginOptions(BaseModel):
    """Base of a plugin's `Options`: a pydantic model whose fields (with
    defaults and descriptions) are the plugin's per-node settings. Its JSON
    schema drives the admin UI's options form; unknown keys are an error so a
    typo in the YAML is caught at validation, not ignored."""

    model_config = {"extra": "forbid"}


class FiestaPlugin:
    #: Registry key; must match the name used in node YAMLs and the frontend
    #: plugin registry.
    name: str = ""
    #: One or two sentences for the admin UI's plugin list.
    description: str = ""
    #: Per-node options (see PluginOptions). The plain base means "no options".
    Options: type[PluginOptions] = PluginOptions

    def options(self, node: NodeConfig) -> PluginOptions:
        """This node's options: the YAML `plugins.<name>` map over the
        defaults. Raises ValueError (with the plugin named) when they do not
        fit the schema."""
        try:
            return self.Options(**node.plugins.get(self.name, {}))
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}"
                for e in exc.errors()
            )
            raise ValueError(f"plugin {self.name!r} options: {problems}") from None

    def options_schema(self) -> dict[str, Any]:
        """JSON schema of `Options` (pydantic's), for the admin UI."""
        return self.Options.model_json_schema()

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        """Validate options against the node (its data model, levels, ...);
        raise ValueError. Runs at startup and before every publication."""

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
        """Extra API routes, mounted at /v2/{repository}/plugins/{plugin.name} and
        served only for nodes that activate this plugin; handlers take NodeDep."""
        return None

    def frontend_config(self, node: NodeConfig) -> dict:
        """Arbitrary JSON surfaced to the SPA via GET /api/config under
        `plugins[name]` — the UI plugin reads its options from here."""
        return {}
