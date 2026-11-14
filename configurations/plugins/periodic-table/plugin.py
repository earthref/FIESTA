"""KdD: a periodic-table element filter in the search sidebar.

Port of the legacy KdD "Periodic Table of Elements" filter: a sidebar entry
opens a modal with the elements laid out as the periodic table, each counted
by the records of the current search (its other filters applied) that have
it, and picking elements filters the search to any of them. The element
layout is static data in the UI half (`elements.ts`); the backend only names
the column that holds the elements and lets the search API count it as a
facet (`search_facets`), so a pick is the core's `<column>:"<value>"` token.
"""

from pydantic import Field

from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions


class PeriodicTableOptions(PluginOptions):
    table: str = Field(default="kds", description="Data model table that holds the element column")
    column: str = Field(
        default="element",
        description="Column whose values are elements (symbols such as Na, or names such as "
        "Sodium); the filter counts and matches its values",
    )
    levels: list[str] = Field(
        default=[], description="Search levels that show the filter (empty = every level)"
    )
    label: str = Field(
        default="Periodic Table", description="The filter's name in the sidebar"
    )


class PeriodicTablePlugin(FiestaPlugin):
    name = "periodic-table"
    description = (
        "A periodic table of elements in the search sidebar: the elements in the search, "
        "counted, picked to filter the records to any of them."
    )
    Options = PeriodicTableOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, PeriodicTableOptions)
        tables = node.load_data_model(node.data_model.latest)["tables"]
        if options.table not in tables:
            raise ValueError(
                f"plugin 'periodic-table': {options.table!r} is not a data model table"
            )
        if options.column not in tables[options.table].get("columns", {}):
            raise ValueError(
                f"plugin 'periodic-table': {options.column!r} is not a {options.table} column"
            )
        levels = {lvl.name for lvl in node.search.levels}
        if unknown := [lvl for lvl in options.levels if lvl not in levels]:
            raise ValueError(f"plugin 'periodic-table': levels {unknown} are not search levels")

    def search_facets(self, node: NodeConfig) -> list[str]:
        options = self.options(node)
        assert isinstance(options, PeriodicTableOptions)
        return [options.column]

    def frontend_config(self, node: NodeConfig) -> dict:
        options = self.options(node)
        assert isinstance(options, PeriodicTableOptions)
        return options.model_dump()
