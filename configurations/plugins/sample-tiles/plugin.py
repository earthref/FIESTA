"""Sample tiles: the legacy EarthRef result card's sample columns as summary
grid tiles — Geology (class, type, lithology), Age (range and unit),
Intensity (paleointensity range in nT/µT/mT and N) and Method Codes.

Each reads a record's `summary._all` values of the columns its options name,
so it needs no derived documents (no reindex); a node without those columns
shows the tile's "No ... Data" placeholder, as the legacy card did. All four
are default tiles: a search level that configures no `columns` shows them
after Geography; a level that does may name them (`cell: intensity`).
"""

from pydantic import Field

from fiesta.nodeconfig import NodeConfig, SearchLevel
from fiesta.plugins.base import FiestaPlugin, GridTile, GridTileFields, PluginOptions

Columns = list[str]


class SampleTilesOptions(PluginOptions):
    geologic_class_columns: Columns = Field(
        default=["geologic_classes"], description="Geology tile: the Class line's columns"
    )
    geologic_type_columns: Columns = Field(
        default=["geologic_types"], description="Geology tile: the Type line's columns"
    )
    lithology_columns: Columns = Field(
        default=["lithologies"], description="Geology tile: the Lithology line's columns"
    )
    age_columns: Columns = Field(
        default=["ages", "age"],
        description="Age tile: the columns tried in order for the age range",
    )
    age_unit_column: str = Field(default="age_unit", description="Age tile: the unit's column")
    intensity_columns: Columns = Field(
        default=["int_abs", "intensities"],
        description="Intensity tile: the columns tried in order, in Tesla",
    )
    method_code_columns: Columns = Field(
        default=["method_codes"], description="Method Codes tile: the codes' columns"
    )


def _all(columns: list[str], suffix: str = "") -> list[str]:
    return [f"summary._all.{c}{suffix}" for c in columns]


class SampleTilesPlugin(FiestaPlugin):
    name = "sample-tiles"
    description = (
        "Geology, Age, Intensity and Method Codes tiles for the search summary grid "
        "(the legacy result card's sample columns), shown by default after Geography."
    )
    Options = SampleTilesOptions
    grid_tiles = (
        GridTile("geology", "Geology", 125, "Geologic class, type and lithology", default=True),
        GridTile("age", "Age", 120, "Age range and unit", default=True),
        GridTile("intensity", "Intensity", 90, "Paleointensity range and N", default=True),
        GridTile("method_codes", "Method Codes", 125, "Method codes", default=True),
    )

    def grid_tile_fields(self, node: NodeConfig, level: SearchLevel, cell: str) -> GridTileFields:
        options = self.options(node)
        assert isinstance(options, SampleTilesOptions)
        match cell:
            case "geology":
                geology = [
                    *options.geologic_class_columns,
                    *options.geologic_type_columns,
                    *options.lithology_columns,
                ]
                return GridTileFields(
                    sort_fields=_all(options.geologic_class_columns, ".raw"),
                    filter_fields=_all(geology),
                    facets=geology,
                )
            case "age":
                return GridTileFields(
                    sort_fields=_all(options.age_columns, ".raw"),
                    sort_type="number",
                    filter_fields=_all(options.age_columns),
                )
            case "intensity":
                return GridTileFields(
                    sort_fields=_all(options.intensity_columns, ".raw"), sort_type="number"
                )
            case _:  # method_codes
                return GridTileFields(
                    sort_fields=_all(options.method_code_columns, ".raw"),
                    filter_fields=_all(options.method_code_columns),
                    facets=list(options.method_code_columns),
                )

    def frontend_config(self, node: NodeConfig) -> dict:
        return self.options(node).model_dump()
