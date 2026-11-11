"""Method codes: a node's method-code vocabulary (MagIC's `method_codes.json`).

The legacy MagIC Method Codes page and vocabulary, ported out of core: the
codes file is `<slug>/<file>` in the node's configuration folder, a
`{group: {label, codes: [{code, definition, ...}]}}` map. The plugin serves it
to the SPA (the Method Codes page, the home page's resource card, the
definitions shown beside facet values) and gives the validator a
case-insensitive `cv("<vocabulary>")` list of every code.
"""

import json
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import Field

from fiesta.apps.deps import NodeDep
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions, PluginVocabulary


class MethodCodesOptions(PluginOptions):
    file: str = Field(
        default="method_codes.json",
        pattern=r"^[\w.-]+\.json$",
        description="The codes file in the node's configuration folder: "
        "{group: {label, codes: [{code, definition}]}}",
    )
    vocabulary: str = Field(
        default="method_codes",
        pattern=r"^\w+$",
        description='The vocabulary name data-model validations use (cv("method_codes"))',
    )


def load_codes(node: NodeConfig, options: MethodCodesOptions) -> dict[str, Any] | None:
    """The node's codes file, or None without one; ValueError when malformed."""
    path = node.base_dir / node.node.slug / options.file
    if not path.is_file():
        return None
    try:
        codes = json.loads(path.read_text())
    except ValueError as exc:
        raise ValueError(f"plugin 'method-codes': {options.file}: {exc}") from None
    if not isinstance(codes, dict) or not all(
        isinstance(group, dict) and isinstance(group.get("codes", []), list)
        for group in codes.values()
    ):
        raise ValueError(
            f"plugin 'method-codes': {options.file} is not a {{group: {{label, codes: [...]}}}} map"
        )
    return codes


def code_set(codes: dict[str, Any]) -> frozenset[str]:
    return frozenset(
        str(entry["code"])
        for group in codes.values()
        for entry in group.get("codes", [])
        if isinstance(entry, dict) and entry.get("code")
    )


class MethodCodesPlugin(FiestaPlugin):
    name = "method-codes"
    description = (
        "A method-code vocabulary: the Method Codes page and home card, code "
        "definitions beside facet values, and case-insensitive validation of the "
        "codes in cv() columns."
    )
    Options = MethodCodesOptions
    pages = ("method-codes",)

    def _options(self, node: NodeConfig) -> MethodCodesOptions:
        options = self.options(node)
        assert isinstance(options, MethodCodesOptions)
        return options

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, MethodCodesOptions)
        load_codes(node, options)

    def vocabularies(self, node: NodeConfig) -> dict[str, PluginVocabulary]:
        options = self._options(node)
        codes = load_codes(node, options)
        if codes is None:
            return {}
        return {options.vocabulary: PluginVocabulary(code_set(codes), case_insensitive=True)}

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("")
        async def method_codes(node: NodeDep) -> dict:
            """The codes by group: {<group>: {label, codes: [{code, definition, ...}]}}."""
            codes = load_codes(node, self._options(node))
            if codes is None:
                raise HTTPException(404, "this node has no method codes")
            return codes

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        options = self._options(node)
        return {"has_codes": (node.base_dir / node.node.slug / options.file).is_file()}
