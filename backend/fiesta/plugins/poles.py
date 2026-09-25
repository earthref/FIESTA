"""MagIC: paleomagnetic poles — derived, searchable pole documents.

The legacy app had a `Poles` view (a sub-tab of the Locations level) querying
docs with `type: "poles"`, but nothing ever indexed them (the view was driven
client-side from location rows). This plugin makes the intent real: at
summarize time, every locations row carrying both `pole_lat` and `pole_lon`
becomes a `poles` search doc. `poles` is a searchable table (not a top-level
tab); the frontend surfaces it as a sub-tab of Locations, after "Rows".
"""

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from fiesta.apps.deps import NodeDep
from fiesta.domain.parse import ParsedContribution
from fiesta.domain.summarize import FACETABLE_COLUMNS
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions
from fiesta.plugins.util import to_float

# MagIC age_unit controlled vocabulary → years-before-present multiplier.
AGE_UNIT_YEARS = {
    "Ga": 1e9,
    "Ma": 1e6,
    "ka": 1e3,
    "Ka": 1e3,
    "Years": 1.0,
    "Years BP": 1.0,
    "Years Cal BP": 1.0,
    "Years AD": 1.0,
    "Years Cal AD": 1.0,
}


class AgeColors(BaseModel):
    """The age gradient poles are colored by (young -> old), plus the colors
    for an unknown age and for the selected pole."""

    young: str = "#ffff00"
    old: str = "#ff0000"
    unknown: str = "#000000"
    selected: str = "#800080"


class PolesOptions(PluginOptions):
    display_columns: list[str] = Field(
        default=["pole_lat", "pole_lon", "pole_alpha95", "age", "age_unit"],
        description="Location columns shown on a pole result item, in order",
    )
    base_level: str = Field(
        default="Locations",
        description="Search level the Poles view attaches to as a sub-tab",
    )
    after_sub_tab: str = Field(
        default="Rows", description="Result sub-tab the Poles tab is placed after"
    )
    age_color: AgeColors = Field(default=AgeColors(), description="Pole colors by age")
    plate_boundary_color: str = Field(
        default="#990000", description="Color of the plate boundary lines on the globes"
    )


class PolesPlugin(FiestaPlugin):
    name = "poles"
    description = (
        "Derives a searchable `poles` document from every location row with a pole "
        "latitude and longitude, and shows them as a sub-tab with globe maps."
    )
    Options = PolesOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, PolesOptions)
        levels = {lvl.name for lvl in node.search.levels}
        if options.base_level not in levels:
            raise ValueError(
                f"plugin 'poles': base_level {options.base_level!r} is not a search level"
            )
        columns = node.load_data_model(node.data_model.latest)["tables"]["locations"]["columns"]
        unknown = [c for c in options.display_columns if c not in columns]
        if unknown:
            raise ValueError(f"plugin 'poles': display_columns {unknown} are not locations columns")

    def search_tables(self, node: NodeConfig) -> list[str]:
        return ["poles"]

    def derive_docs(
        self, node: NodeConfig, parsed: ParsedContribution, contribution_meta: dict
    ) -> list[dict]:
        docs: list[dict] = []
        for row in parsed.tables.get("locations", []):
            pole_lat = to_float(row.get("pole_lat"))
            pole_lon = to_float(row.get("pole_lon"))
            if pole_lat is None or pole_lon is None:
                continue
            all_block: dict[str, Any] = {
                "pole_lat": [str(pole_lat)],
                "pole_lon": [str(pole_lon)],
            }
            for column in FACETABLE_COLUMNS:
                if row.get(column):
                    all_block[column] = [
                        v.strip() for v in str(row[column]).split(":") if v.strip()
                    ]
            if -90 <= pole_lat <= 90:
                all_block["_geo_point"] = {
                    "lat": pole_lat,
                    "lon": ((pole_lon + 180) % 360) - 180,
                }
            # Numeric copies (JSON numbers map to numeric OpenSearch fields)
            # so age/alpha95 range filters work; string row values don't. Age
            # is normalized to years-before-present via age_unit so the color
            # gradient and legend are consistent across mixed-unit poles.
            numeric_block = {"pole_lat": pole_lat, "pole_lon": pole_lon}
            alpha95 = to_float(row.get("pole_alpha95"))
            if alpha95 is not None:
                numeric_block["pole_alpha95"] = alpha95
            unit_factor = AGE_UNIT_YEARS.get((row.get("age_unit") or "Ma").strip(), 1e6)
            age = to_float(row.get("age"))
            if age is None:
                low, high = to_float(row.get("age_low")), to_float(row.get("age_high"))
                if low is not None and high is not None:
                    age = (low + high) / 2
            if age is not None:
                numeric_block["age"] = age * unit_factor  # years before present
            docs.append(
                {
                    "type": "poles",
                    "summary": {
                        "contribution": contribution_meta,
                        "locations": dict(row),
                        "poles": numeric_block,
                        "_all": all_block,
                    },
                    "rows": [row],
                }
            )
        return docs

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/plate-boundaries")
        async def plate_boundaries(node: NodeDep) -> dict:
            """Tectonic plate boundary polygons (GeoJSON) for the globes."""
            path = node.base_dir / node.node.slug / "plate_boundaries.json"
            if not path.exists():
                raise HTTPException(404, "this node has no plate boundary data")
            import json

            return json.loads(path.read_text())

        @router.get("/base-texture")
        async def base_texture(node: NodeDep) -> FileResponse:
            """Earth relief image used as the globe surface texture."""
            path = node.base_dir / node.node.slug / "global_relief_map.jpg"
            if not path.exists():
                raise HTTPException(404, "this node has no globe texture")
            return FileResponse(path, media_type="image/jpeg")

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        # The Age / Pole A95 / Geospatial controls on the Poles view are
        # `search.filters` entries in the node YAML (range on
        # summary.poles.age and summary.poles.pole_alpha95, bbox).
        return {
            "view": "poles",
            "table": "poles",
            **self.options(node).model_dump(),
            "has_plate_boundaries": (
                node.base_dir / node.node.slug / "plate_boundaries.json"
            ).exists(),
            "has_base_texture": (node.base_dir / node.node.slug / "global_relief_map.jpg").exists(),
        }
