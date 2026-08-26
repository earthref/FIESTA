"""MagIC: paleomagnetic poles — a derived search level.

The legacy app had a `Poles` search view querying docs with `type: "poles"`,
but nothing ever indexed them (the view was driven client-side from location
rows). This plugin makes the intent real: at summarize time, every locations
row carrying both `pole_lat` and `pole_lon` becomes a `poles` search doc, so
the Poles tab is a first-class, server-backed search level.
"""

from typing import Any

from fiesta.domain.parse import ParsedContribution
from fiesta.domain.summarize import FACETABLE_COLUMNS
from fiesta.nodeconfig import NodeConfig, SearchLevel
from fiesta.plugins.base import FiestaPlugin
from fiesta.plugins.util import to_float


class PolesPlugin(FiestaPlugin):
    name = "poles"

    #: Columns surfaced on the pole list item, in render order (MagIC 3.0
    #: names the a95 column `pole_alpha95`).
    DISPLAY_COLUMNS = ["pole_lat", "pole_lon", "pole_alpha95", "age", "age_unit"]

    def search_levels(self, node: NodeConfig) -> list[SearchLevel]:
        return [SearchLevel(name="Poles", table="poles")]

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
            docs.append(
                {
                    "type": "poles",
                    "summary": {
                        "contribution": contribution_meta,
                        "locations": dict(row),
                        "_all": all_block,
                    },
                    "rows": [row],
                }
            )
        return docs

    def frontend_config(self, node: NodeConfig) -> dict:
        return {
            "view": "poles",
            "level": "Poles",
            "display_columns": self.DISPLAY_COLUMNS,
            # The legacy Poles view used a reduced filter set.
            "filters": ["age", "geospatial"],
        }
