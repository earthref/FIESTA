"""MagIC: paleomagnetic poles — derived, searchable pole documents.

The legacy app had a `Poles` view (a sub-tab of the Locations level) querying
docs with `type: "poles"`, but nothing ever indexed them (the view was driven
client-side from location rows). This plugin makes the intent real: at
summarize time, every locations row carrying both `pole_lat` and `pole_lon`
becomes a `poles` search doc. `poles` is a searchable table (not a top-level
tab); the frontend surfaces it as a sub-tab of Locations, after "Rows".

Each doc also carries the pole's uncertainty outline, computed here with
PmagPy so the map only draws it: the α95 circle (`pmag.circ`, the pole's
lon/lat as a dec/inc), else the dp/dm ellipse (`pmagplotlib.plot_ell`) with dp
along the great circle from the pole toward the location (its azimuth from
`pmag.vgp_di`, the axes placed with `pmag.dodirot`). It is stored at
`summary.poles._geometry` = `{"kind": "alpha95" | "dp_dm", "ring": [[lon,
lat], ...]}` (a closed ring, longitudes in -180..180, 2 decimals), a field the
index maps `enabled: false` (`fiesta.search.index`): returned with the doc,
never searched, faceted or unioned into `summary._all`. A row whose α95 /
dp / dm / position is blank, malformed or out of range just has no ring.
"""

import contextlib
import io
import math
import warnings
from functools import cache
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pmagpy import pmag
from pydantic import BaseModel, Field

from fiesta.apps.deps import NodeDep
from fiesta.domain.parse import ParsedContribution
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


# Vertices per uncertainty ring (closed: the last repeats the first), a 3.6°
# step; and the decimals kept (0.01° ≈ 1 km), to keep the docs small.
RING_POINTS = 101
RING_DECIMALS = 2


def _finite(value) -> float | None:
    number = to_float(value)
    return number if number is not None and math.isfinite(number) else None


def _uncertainty(value) -> float | None:
    """An α95 / dp / dm in (0, 90]° — anything else draws no ring."""
    number = _finite(value)
    return number if number is not None and 0 < number <= 90 else None


def location_site(row: dict) -> tuple[float, float] | None:
    """A location row's position (lat, lon): its lat/lon, else the middle of
    its lat_s/lat_n/lon_w/lon_e box (a box across 0°/360° handled)."""
    lat, lon = _finite(row.get("lat")), _finite(row.get("lon"))
    if lat is not None and lon is not None:
        return (lat, lon) if -90 <= lat <= 90 else None
    s, n, w, e = (_finite(row.get(k)) for k in ("lat_s", "lat_n", "lon_w", "lon_e"))
    if s is None or n is None or w is None or e is None:
        return None
    if not (-90 <= s <= 90 and -90 <= n <= 90):
        return None
    west, east = w % 360, e % 360
    if east < west:
        east += 360
    return (s + n) / 2, (west + east) / 2


def _ring(lons, lats) -> list[list[float]] | None:
    ring = [
        [round((float(lon) + 180) % 360 - 180, RING_DECIMALS), round(float(lat), RING_DECIMALS)]
        for lon, lat in zip(lons, lats, strict=True)
    ]
    if len(ring) < 4 or not all(math.isfinite(v) for point in ring for v in point):
        return None
    return ring


def alpha95_ring(pole_lat: float, pole_lon: float, alpha95: float) -> list[list[float]] | None:
    """The α95 circle around a pole: PmagPy's small circle about a direction,
    with the pole's lon/lat as its dec/inc."""
    lons, lats = pmag.circ(pole_lon, pole_lat, alpha95, npts=RING_POINTS)
    return _ring(lons, lats)


@cache
def _plot_ell():
    # pmagplotlib loads matplotlib, prints a cartopy notice on stdout and
    # silences every warning process-wide: import it once, on first use,
    # without either side effect.
    with warnings.catch_warnings(), contextlib.redirect_stdout(io.StringIO()):
        from pmagpy import pmagplotlib
    return pmagplotlib.plot_ell


def dp_dm_ring(
    pole_lat: float, pole_lon: float, site: tuple[float, float], dp: float, dm: float
) -> list[list[float]] | None:
    """The dp/dm confidence ellipse around a pole: semi-axis dp along the
    great circle from the pole toward its site, dm across it (Butler 1992).
    PmagPy's ellipse about a direction, with the pole's lon/lat as its dec/inc
    and the axes as the points 90° from it along and across that circle."""
    site_lat, site_lon = site
    # A pole's declination at a site points along the great circle to it; so,
    # with the roles swapped, the azimuth from the pole toward the site.
    azimuth, _ = pmag.vgp_di(site_lat, site_lon, pole_lat, pole_lon)
    if not math.isfinite(azimuth):
        return None  # the site is the pole (or its antipode): no great circle
    # dodirot measures its declination the other way round from an azimuth.
    along = pmag.dodirot((-azimuth) % 360, 0.0, pole_lon, pole_lat)
    across = pmag.dodirot((-azimuth - 90) % 360, 0.0, pole_lon, pole_lat)
    points = _plot_ell()(
        None, [pole_lon, pole_lat, dp, *along, dm, *across], lower=False, plot=False
    )
    # plot_ell samples 201 points (a closed ring): keep every other one.
    points = points[::2]
    return _ring([p[0] for p in points], [p[1] for p in points])


def uncertainty_ring(row: dict, pole_lat: float, pole_lon: float) -> dict | None:
    """A location row's pole outline, `{"kind", "ring"}`: its α95 circle, else
    its dp/dm ellipse, else None. Never raises: a malformed legacy row (or a
    PmagPy failure on one) only loses its ring."""
    if not (-90 <= pole_lat <= 90):
        return None
    try:
        with np.errstate(all="ignore"):
            alpha95 = _uncertainty(row.get("pole_alpha95"))
            if alpha95 is not None:
                ring = alpha95_ring(pole_lat, pole_lon, alpha95)
                return {"kind": "alpha95", "ring": ring} if ring else None
            dp, dm = _uncertainty(row.get("pole_dp")), _uncertainty(row.get("pole_dm"))
            site = location_site(row)
            if dp is not None and dm is not None and site is not None:
                ring = dp_dm_ring(pole_lat, pole_lon, site, dp, dm)
                return {"kind": "dp_dm", "ring": ring} if ring else None
    except Exception:  # noqa: BLE001 — one bad row must not fail the contribution
        return None
    return None


class AgeColors(BaseModel):
    """The age gradient poles are colored by (young -> old), plus the colors
    for an unknown age and for the selected pole."""

    young: str = "#ffff00"
    old: str = "#ff0000"
    unknown: str = "#000000"
    selected: str = "#800080"


# The columns a pole doc's summary._all carries (the legacy facet columns).
FACET_COLUMNS = [
    "method_codes",
    "geologic_classes",
    "geologic_types",
    "lithologies",
    "location_type",
    "plate_blocks",
    "tectonic_settings",
    "citations",
]


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
        default="#990000", description="Color of the plate boundary lines on the map"
    )
    default_alpha95_max: float | None = Field(
        default=10.0,
        description="An unfiltered Poles view of more than `default_alpha95_above` poles "
        "opens with a Pole A95 range filter up to this many degrees (null: never)",
    )
    default_alpha95_above: int = Field(
        default=1000,
        description="The pole count past which an unfiltered Poles view gets the default "
        "Pole A95 filter",
    )
    facet_columns: list[str] = Field(
        default=FACET_COLUMNS,
        description="Location columns copied (colon-delimited lists split) into a pole's "
        "summary._all, for its facets and free-text search",
    )


class PolesPlugin(FiestaPlugin):
    name = "poles"
    description = (
        "Derives a searchable `poles` document from every location row with a pole "
        "latitude and longitude, and shows them as a sub-tab on a map with plate "
        "boundaries and uncertainty ellipses."
    )
    Options = PolesOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, PolesOptions)
        levels = {lvl.name for lvl in node.search.levels}
        if options.base_level not in levels:
            raise ValueError(
                f"plugin 'poles': base_level {options.base_level!r} is not a search level"
            )
        tables = node.load_data_model(node.data_model.latest)["tables"]
        if "locations" not in tables:
            raise ValueError("plugin 'poles': the data model has no ['locations'] table")
        columns = tables["locations"]["columns"]
        unknown = [c for c in options.display_columns if c not in columns]
        if unknown:
            raise ValueError(f"plugin 'poles': display_columns {unknown} are not locations columns")

    def search_tables(self, node: NodeConfig) -> list[str]:
        return ["poles"]

    def derive_docs(
        self, node: NodeConfig, parsed: ParsedContribution, contribution_meta: dict
    ) -> list[dict]:
        docs: list[dict] = []
        facet_columns = self.options(node).facet_columns
        for row in parsed.tables.get("locations", []):
            pole_lat = _finite(row.get("pole_lat"))
            pole_lon = _finite(row.get("pole_lon"))
            if pole_lat is None or pole_lon is None:
                continue
            all_block: dict[str, Any] = {
                "pole_lat": [str(pole_lat)],
                "pole_lon": [str(pole_lon)],
            }
            for column in facet_columns:
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
            numeric_block: dict[str, Any] = {"pole_lat": pole_lat, "pole_lon": pole_lon}
            alpha95 = _finite(row.get("pole_alpha95"))
            if alpha95 is not None:
                numeric_block["pole_alpha95"] = alpha95
            unit_factor = AGE_UNIT_YEARS.get((row.get("age_unit") or "Ma").strip(), 1e6)
            age = _finite(row.get("age"))
            if age is None:
                low, high = _finite(row.get("age_low")), _finite(row.get("age_high"))
                if low is not None and high is not None:
                    age = (low + high) / 2
            if age is not None:
                numeric_block["age"] = age * unit_factor  # years before present
            # The outline the map draws (unindexed; see the module docstring).
            geometry = uncertainty_ring(row, pole_lat, pole_lon)
            if geometry is not None:
                numeric_block["_geometry"] = geometry
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
            """Tectonic plate boundary polygons (GeoJSON) for the map."""
            path = node.base_dir / node.node.slug / "plate_boundaries.json"
            if not path.exists():
                raise HTTPException(404, "this node has no plate boundary data")
            import json

            return json.loads(path.read_text())

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
        }
