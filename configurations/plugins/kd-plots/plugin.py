"""KdD: partition-coefficient plots — spider diagrams, Onuma diagrams, Kd by element.

The legacy KdD app had no plots. This plugin draws a search's (or one
contribution's) partition coefficients three ways: a spider diagram (log Kd
against the elements in incompatibility, REE or atomic-number order, one line
per pattern), an Onuma diagram (log Kd against the ionic radius, one curve per
valence) and the spread of Kd per element. A pattern is a contribution's rows
that share the `pattern_columns` (mineral, rock type, Kd definition and types).

No routes: the UI reads the rows through the core `GET /v2/{node}/search/{table}/values`,
which applies the search's filters and the visibility rules. The element data
(atomic numbers, assumed valences and Shannon radii) is static in the UI half.
"""

from pydantic import Field

from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions


class KdPlotsOptions(PluginOptions):
    table: str = Field(default="kds", description="Data model table that holds the Kd rows")
    levels: list[str] = Field(
        default=["Partition Coefficients"],
        description="Search levels (on `table`) that get the Kd Plots sub-tab",
    )
    element: str = Field(default="element", description="Column naming the element (a symbol)")
    kd: str = Field(default="kd", description="Column with the partition coefficient")
    kd_sigma: str = Field(default="kd_sigma", description="Column with Kd's one-sigma uncertainty")
    kd_low: str = Field(default="kd_low", description="Column with the low end of a Kd range")
    kd_high: str = Field(default="kd_high", description="Column with the high end of a Kd range")
    pattern_columns: list[str] = Field(
        default=["minerals", "rock_types", "kd_definition", "kd_types"],
        description="Columns that, with the contribution, make one pattern (one plotted line); "
        "each is also a Color by choice",
    )


class KdPlotsPlugin(FiestaPlugin):
    name = "kd-plots"
    description = (
        "Partition-coefficient plots: spider diagrams, Onuma (Kd against ionic radius) "
        "diagrams and Kd by element, as a search sub-tab and a contribution tab."
    )
    Options = KdPlotsOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, KdPlotsOptions)
        tables = node.load_data_model(node.data_model.latest)["tables"]
        if options.table not in tables:
            raise ValueError(f"plugin 'kd-plots': {options.table!r} is not a data model table")
        columns = tables[options.table].get("columns", {})
        wanted = [
            options.element,
            options.kd,
            options.kd_sigma,
            options.kd_low,
            options.kd_high,
            *options.pattern_columns,
        ]
        if unknown := [c for c in wanted if c not in columns]:
            raise ValueError(f"plugin 'kd-plots': {unknown} are not {options.table} columns")
        by_name = {lvl.name: lvl for lvl in node.search.levels}
        if unknown := [lvl for lvl in options.levels if lvl not in by_name]:
            raise ValueError(f"plugin 'kd-plots': levels {unknown} are not search levels")
        if other := [lvl for lvl in options.levels if by_name[lvl].table != options.table]:
            raise ValueError(
                f"plugin 'kd-plots': levels {other} do not search the {options.table!r} table"
            )

    def frontend_config(self, node: NodeConfig) -> dict:
        options = self.options(node)
        assert isinstance(options, KdPlotsOptions)
        tables = node.load_data_model(node.data_model.latest)["tables"]
        columns = tables[options.table].get("columns", {})
        return {
            **options.model_dump(),
            # The Color by menu's names for the pattern columns.
            "labels": {c: columns[c].get("label") or c for c in options.pattern_columns},
        }
