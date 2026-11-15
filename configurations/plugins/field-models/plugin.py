"""Geomagnetic field models: predicted field curves, uncertainty bands,
ensembles and global maps from published spherical-harmonic models, beside a
search's paleomagnetic data.

The science is GEOMAGIA's field-model pages (field_models/ in the GEOMAGIA
Django site): SHMODEL synthesis of cubic B-spline Gauss coefficient models
(shmodel.py, a numpy port agreeing with the compiled Fortran to ~1e-12),
GEOMAGIA's request validation and limits (no extrapolation, at most 4,001
points per curve, 1,000 curves and 500,000 values per request), the search's
distinct intensity and direction site locations or their medians, ensemble
standard deviations, and the 5-degree global grid with the core-mantle
boundary radial field and secular accelerations.

The models are not in this repository. fetch_models.py downloads them from
their public sources (models.yaml) into the node's storage under
`storage_prefix`; this module reads `catalog.json` and the coefficient files
from there and keeps them in memory (ensembles as memory-mapped local copies).
Without a catalogue the view says so and offers nothing to plot.
"""

import asyncio
import datetime as dt
import hashlib
import importlib.util
import json
import math
import sys
import tempfile
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from fiesta.apps.deps import NodeDep
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions


def _sibling(name: str):
    """Load a module beside this file (plugin.py imports as a single module)."""
    full = f"{__name__}_{name}"
    if full not in sys.modules:
        spec = importlib.util.spec_from_file_location(full, Path(__file__).with_name(f"{name}.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[full] = module
        spec.loader.exec_module(module)
    return sys.modules[full]


shmodel = _sibling("shmodel")
convert = _sibling("convert")

# GEOMAGIA's dataset groups (catalog.py DATASET_GROUPS), in its order.
DATASET_GROUPS = {
    "archaeo": "Archaeological and volcanic data",
    "mixed": "Archaeological, volcanic and sediment data",
    "sediment": "Sedimentary data",
    "historical_mixed": "Archaeological, volcanic and historical observations",
    "historical_archaeo": "Archaeological and historical observations",
    "historical": "Historical observations",
    "volcanic_sediment": "Volcanic and sediment data",
}
INTERPOLATION_NOTE = (
    "Cubic interpolation of supplied epoch coefficients. Between-epoch fields and acceleration "
    "reflect this interpolation rather than a recovered native time model."
)
UNCERTAINTY_DEFINITION = (
    "Pointwise sample standard deviation of all supplied ensemble predictions (ddof=1); "
    "bands are mean curve ±1 SD."
)
ENSEMBLE_DEFINITION = "Pointwise ensemble sample standard deviation (ddof=1); mean curve ±1 SD."
MAX_MEMBER_POINTS = 2_000_000
MAX_SYNTHESIS_TERMS = 250_000_000
MAX_SITE_ROWS = 60_000


class ColumnMap(BaseModel):
    model_config = {"extra": "forbid"}
    latitude: str = Field(default="lat", description="Site latitude (degrees north)")
    longitude: str = Field(default="lon", description="Site longitude (degrees east, -180..360)")
    age: str = Field(default="age", description="Age in calendar years (negative BCE)")
    age_minus: str = Field(
        default="age_min", description="Age uncertainty toward older ages (years)"
    )
    age_plus: str = Field(
        default="age_max", description="Age uncertainty toward younger ages (years)"
    )
    intensity: str = Field(default="ba", description="Paleointensity (μT)")
    intensity_error: str = Field(default="sigma_ba", description="Paleointensity uncertainty (μT)")
    vadm: str = Field(default="vadm", description="VADM (10²² A·m²)")
    vadm_error: str = Field(default="sigma_vadm", description="VADM uncertainty (10²² A·m²)")
    declination: str = Field(default="decl", description="Declination (degrees)")
    inclination: str = Field(default="incl", description="Inclination (degrees)")
    region: str = Field(default="region_country", description="Region the overlay colours by")
    locality: str = Field(default="site_name", description="Locality shown on hover")
    record: str = Field(default="uid", description="Record identifier shown on hover")
    age_error_type: str = Field(
        default="age_error_type", description="Age error type shown on hover"
    )
    sigmas: str = Field(default="num_sigmas", description="Number of sigmas the age errors span")


class FieldModelsOptions(PluginOptions):
    base_level: str = Field(
        default="Sites", description="Search level the Field Models view attaches to as a sub-tab"
    )
    table: str = Field(default="sites", description="Data-model table of the base level's rows")
    columns: ColumnMap = Field(
        default_factory=ColumnMap, description="Which columns hold the overlaid measurements"
    )
    default_models: list[str] = Field(
        default=["CALS10k.2"], description="Models selected when the view opens"
    )
    default_latitude: float = Field(default=50, ge=-90, le=90)
    default_longitude: float = Field(default=10, ge=-180, le=360)
    default_start_year: float = Field(default=-1000)
    default_end_year: float = Field(default=1990)
    default_step: float = Field(default=10, ge=1)
    storage_prefix: str = Field(
        default="field-models/",
        description="Key prefix in the node's storage where fetch_models.py writes the models",
    )


# --- Model store: catalogue, coefficient files and ensembles from the bucket -------------


class ModelStore:
    """catalog.json (re-read every few minutes), parsed models keyed by
    sha256 (immutable, LRU), ensembles as verified local memory maps."""

    CATALOG_TTL = 300.0

    def __init__(self) -> None:
        self._catalogs: dict[tuple, tuple[float, dict | None]] = {}
        self._models: OrderedDict[str, Any] = OrderedDict()
        self._cubes: OrderedDict[str, np.ndarray] = OrderedDict()
        self._lock = asyncio.Lock()

    @staticmethod
    def _storage(node: NodeConfig):
        from fiesta.storage import Storage

        return Storage.for_node(node)

    async def catalog(self, node: NodeConfig, prefix: str) -> dict | None:
        key = (node.bucket, node.storage_prefix, prefix)
        cached = self._catalogs.get(key)
        if cached and time.monotonic() - cached[0] < self.CATALOG_TTL:
            return cached[1]
        storage = self._storage(node)
        try:
            data = json.loads(await storage.get_bytes(prefix + "catalog.json"))
        except Exception:  # noqa: BLE001 - no catalogue (or no bucket) yet: nothing to offer
            data = None
        self._catalogs[key] = (time.monotonic(), data)
        return data

    async def model(self, node: NodeConfig, prefix: str, entry: dict):
        digest = entry["sha256"]
        if digest in self._models:
            self._models.move_to_end(digest)
            return self._models[digest]
        async with self._lock:
            if digest not in self._models:
                data = await self._storage(node).get_bytes(prefix + entry["key"])
                if hashlib.sha256(data).hexdigest() != digest:
                    raise HTTPException(
                        503, f"{entry['name']}: stored coefficients changed; rerun fetch_models.py"
                    )
                model = await asyncio.to_thread(
                    shmodel.parse_model, data.decode("latin-1"), entry["name"]
                )
                self._models[digest] = model
                while len(self._models) > 12:
                    self._models.popitem(last=False)
        return self._models[digest]

    async def cube(self, node: NodeConfig, prefix: str, entry: dict) -> np.ndarray:
        info = entry["ensemble"]
        digest = info["sha256"]
        if digest in self._cubes:
            self._cubes.move_to_end(digest)
            return self._cubes[digest]
        async with self._lock:
            if digest not in self._cubes:
                folder = Path(tempfile.gettempdir()) / "fiesta-field-models"
                folder.mkdir(exist_ok=True)
                path = folder / f"{digest}.npy"
                if not path.exists():
                    data = await self._storage(node).get_bytes(prefix + info["key"])
                    if hashlib.sha256(data).hexdigest() != digest:
                        raise HTTPException(
                            503, f"{entry['name']}: stored ensemble changed; rerun fetch_models.py"
                        )
                    staging = path.with_suffix(f".{time.monotonic_ns()}.tmp")
                    staging.write_bytes(data)
                    staging.replace(path)
                cube = np.load(path, mmap_mode="r", allow_pickle=False)
                nc = info["degree"] * (info["degree"] + 2)
                if cube.shape != (len(info["times"]), nc, info["members"]):
                    raise HTTPException(
                        503, f"{entry['name']}: ensemble dimensions disagree with the catalogue"
                    )
                self._cubes[digest] = cube
                while len(self._cubes) > 3:
                    self._cubes.popitem(last=False)
        return self._cubes[digest]


STORE = ModelStore()


# --- Requests ---------------------------------------------------------------------------


class Location(BaseModel):
    latitude: float
    longitude: float


class CurveRequest(BaseModel):
    """GEOMAGIA's model form: models, a manual location or the search's site
    rows ([lat, lon, intensity, declination, inclination] each, distinct),
    the year window and step."""

    models: list[str] = Field(min_length=1, max_length=40)
    location_source: str = Field(default="manual", pattern="^(manual|database)$")
    latitude: float | None = None
    longitude: float | None = None
    altitude: float = 0.0
    sites: list[list[float | None]] = Field(default_factory=list, max_length=MAX_SITE_ROWS)
    use_median: bool = False
    start_year: float
    end_year: float
    step: float = 10.0
    include_members: bool = False


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def normalize_coordinates(latitude, longitude):
    """GEOMAGIA's map coordinates: valid ranges, longitude to -180..180."""
    if latitude is None or longitude is None:
        return None
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 360:
        return None
    if longitude > 180:
        longitude = round(longitude - 360, 10)
    return latitude, -180.0 if longitude == 180 else longitude


def selection_locations(sites) -> dict[str, list[tuple[float, float]]]:
    """Distinct site locations of the search, separately those with an
    intensity (>= 0) and those with a declination (-360..360) or an
    inclination (-90..90) (GEOMAGIA field_models/database.py)."""
    groups: dict[str, set] = {"intensity": set(), "direction": set()}
    for row in sites:
        if len(row) != 5:
            raise HTTPException(
                422, "each site row is [latitude, longitude, intensity, declination, inclination]"
            )
        lat, lon, ba, decl, incl = (_finite(v) for v in row)
        point = normalize_coordinates(lat, lon)
        if point is None:
            continue
        point = (float(point[0]), float(point[1]))
        if ba is not None and ba >= 0:
            groups["intensity"].add(point)
        if (decl is not None and -360 <= decl <= 360) or (incl is not None and -90 <= incl <= 90):
            groups["direction"].add(point)
    return {key: sorted(points) for key, points in groups.items()}


def _fail(message: str):
    raise HTTPException(400, message)


def _metadata(entry: dict) -> dict:
    ensemble = entry.get("ensemble") or {}
    return {
        "citation": entry["citation"],
        "label": f"{entry['name']} — {entry['author']} et al. ({entry['year']})",
        "dataset": DATASET_GROUPS.get(entry["group"], entry["group"]),
        "doi": entry.get("doi"),
        "terms": entry["terms"],
        "source_url": entry["source_url"],
        "interpolated_epochs": entry["interpolated_epochs"],
        "coefficient_note": INTERPOLATION_NOTE
        if entry["interpolated_epochs"]
        else "Original supplied spline coefficients.",
        "temporal_interpolation": "natural cubic"
        if entry["interpolated_epochs"]
        else "original cubic B-spline",
        "coefficient_sha256": entry["sha256"],
        "ensemble_count": ensemble.get("members", 0),
        "ensemble_kind": ensemble.get("kind"),
        "uncertainty_definition": UNCERTAINTY_DEFINITION if ensemble else None,
    }


def resolve_locations(request: CurveRequest, options: FieldModelsOptions):
    """(locations, membership, extra result fields) for a request."""
    if request.location_source == "manual":
        lat, lon, alt = request.latitude, request.longitude, request.altitude
        if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 360:
            _fail("Use a latitude from -90 to 90 and a longitude from -180 to 360.")
        if not shmodel.MIN_ALTITUDE <= alt <= shmodel.MAX_ALTITUDE:
            _fail("Use an altitude from -1 to 100 km.")
        return [(lat, lon)], None, {"location_source": "manual", "location_count": 1}, alt
    groups = selection_locations(request.sites)
    medians = {key: shmodel.median_location(points) for key, points in groups.items()}
    selected = {
        key: ([medians[key]] if medians[key] is not None else []) if request.use_median else points
        for key, points in groups.items()
    }
    locations = sorted(set().union(*selected.values()))
    if not locations:
        _fail("The search has no valid locations with intensity or directional measurements.")
    sets = {key: set(points) for key, points in selected.items()}
    membership = {p: [k for k, s in sets.items() if p in s] for p in locations}
    extra = {
        "location_source": "database",
        "location_count": len(locations),
        "use_median": request.use_median,
        "component_location_counts": {k: len(v) for k, v in groups.items()},
        "plot_location_counts": {k: len(v) for k, v in selected.items()},
        "median_locations": {
            k: {"latitude": p[0], "longitude": p[1]} if p else None for k, p in medians.items()
        },
        "site_groups": groups,
    }
    return locations, membership, extra, 0.0


def validate_window(
    request: CurveRequest, chosen: list[dict], catalog_models: list[dict], locations: int
):
    """GEOMAGIA's ModelForm/ComparisonForm checks and request limits; the
    clipped (start, end) per model."""
    if request.step < 1 or not math.isfinite(request.step):
        _fail("Use a time step of at least 1 year.")
    lower = min(m["start"] for m in catalog_models)
    upper = max(dt.date.today().year, max(m["end"] for m in catalog_models))
    start, end, step = request.start_year, request.end_year, request.step
    for value in (start, end):
        if not math.isfinite(value) or not lower <= value <= upper:
            _fail(f"Use a year from {lower:g} to {upper:g}.")
    if end <= start:
        _fail("The end year must be after the start year.")
    windows = {}
    for entry in chosen:
        span = min(end, entry["end"]) - max(start, entry["start"])
        if span <= 0:
            _fail(
                f"{entry['name']} has no time interval within these dates. "
                f"Its available years are {entry['start']:g} to {entry['end']:g}."
            )
        if math.ceil(span / step) + 1 > shmodel.MAX_POINTS_PER_CURVE:
            _fail(
                "Increase the time step to plot at most "
                f"{shmodel.MAX_POINTS_PER_CURVE:,} points per model."
            )
        windows[entry["name"]] = (max(start, entry["start"]), min(end, entry["end"]))
    curves = len(chosen) * locations
    if curves > shmodel.MAX_TOTAL_CURVES:
        _fail(
            f"This selection needs {curves:,} model curves. Select fewer models or narrow "
            f"the database search to stay within {shmodel.MAX_TOTAL_CURVES:,} curves."
        )
    total = sum((math.ceil((b - a) / step) + 1) * locations for a, b in windows.values())
    if total > shmodel.MAX_TOTAL_POINTS:
        _fail(
            f"This selection needs {total:,} model values. Increase the time step, select fewer "
            "models or narrow the database search to stay within "
            f"{shmodel.MAX_TOTAL_POINTS:,} values."
        )
    return windows


def _list(values) -> list:
    return [float(v) if math.isfinite(v) else None for v in np.asarray(values, dtype=float)]


def _errors(values) -> list:
    return [
        float(v) if math.isfinite(v) and v >= 0 else None for v in np.asarray(values, dtype=float)
    ]


def model_curves(model, entry, window, step, locations, altitude, membership) -> list[dict]:
    """One series per location for a model (GEOMAGIA runner._calculate_batch)."""
    years = shmodel.curve_years(window[0], window[1], step)
    lats = [p[0] for p in locations]
    lons = [p[1] for p in locations]
    out = shmodel.synthesize(model, years, lats, lons, altitude)
    if not np.all(np.isfinite(out["intensity"])) or np.any(out["intensity"] <= 0):
        raise HTTPException(500, f"{entry['name']}: the model calculation failed")
    metadata = _metadata(entry)
    series = []
    for i, (lat, lon) in enumerate(locations):
        factor = shmodel.vadm_factor(lat)
        intensity = out["intensity"][:, i]
        decl = out["decl"][:, i]
        decl = np.where(decl > 180, decl - 360, np.where(decl < -180, decl + 360, decl))
        has = model.has_uncertainty
        unc = _errors(out["intensity_uncertainty"][:, i]) if has else None
        series.append(
            {
                "model": entry["name"],
                "years": _list(years),
                "coefficient_metadata": metadata,
                "intensity": _list(intensity),
                "decl": _list(decl),
                "incl": _list(out["incl"][:, i]),
                "uncertainty": unc,
                "decl_uncertainty": _errors(out["decl_uncertainty"][:, i]) if has else None,
                "incl_uncertainty": _errors(out["incl_uncertainty"][:, i]) if has else None,
                "vadm": _list(intensity * factor),
                "vadm_uncertainty": [v * factor if v is not None else None for v in unc]
                if has
                else None,
                "latitude": lat,
                "longitude": lon,
                "altitude": altitude,
                "location_components": membership[(lat, lon)] if membership else None,
            }
        )
    return series


def ensemble_curves(cube, entry, window, step, locations, altitude, include_members) -> list[dict]:
    info = entry["ensemble"]
    years = shmodel.curve_years(window[0], window[1], step)
    series = []
    for lat, lon in locations:
        vector = shmodel.ensemble_predictions(cube, info["times"], years, lat, lon, altitude)
        errors, members = shmodel.ensemble_statistics(vector, include_members)
        factor = shmodel.vadm_factor(lat)
        unc = _errors(errors["intensity_uncertainty"])
        row = {
            "model": entry["name"],
            "latitude": lat,
            "longitude": lon,
            "altitude": altitude,
            "years": _list(years),
            "uncertainty": unc,
            "decl_uncertainty": _errors(errors["decl_uncertainty"]),
            "incl_uncertainty": _errors(errors["incl_uncertainty"]),
            "vadm_uncertainty": [v * factor if v is not None else None for v in unc],
            "ensemble": None,
        }
        if members is not None:
            row["ensemble"] = {
                "count": info["members"],
                "kind": info["kind"],
                "member_ids": [f"draw-{i + 1:03d}" for i in range(info["members"])],
                **{key: [_list(m) for m in value] for key, value in members.items()},
            }
        series.append(row)
    return series


def global_payload(model, entry, year: float) -> dict:
    frame = shmodel.global_frame(model, year)
    lat = frame["latitudes"]
    nlon = len(frame["longitudes"])
    for key in (
        "intensity",
        "radial",
        "intensity_acceleration",
        "radial_acceleration",
        "incl",
        "decl",
    ):
        if not np.all(np.isfinite(frame[key])):
            raise HTTPException(500, "The global field calculation failed.")
    gad = np.repeat(shmodel.gad_inclination(lat), nlon)
    incl = frame["incl"].reshape(-1)
    return {
        "model": entry["name"],
        "year": year,
        "nlat": len(lat),
        "nlon": nlon,
        "coefficient_metadata": _metadata(entry),
        "latitudes": [float(v) for v in lat],
        "longitudes": [float(v) for v in frame["longitudes"]],
        "intensity": [round(float(v), 6) for v in frame["intensity"].reshape(-1)],
        "decl": [round(float((v + 180) % 360 - 180), 6) for v in frame["decl"].reshape(-1)],
        "incl": [round(float(v), 6) for v in incl],
        "delta_incl": [round(float(v), 6) for v in incl - gad],
        "radial": [round(float(v), 9) for v in frame["radial"].reshape(-1)],
        "intensity_acceleration": [
            round(float(v), 12) for v in frame["intensity_acceleration"].reshape(-1)
        ],
        "radial_acceleration": [
            round(float(v), 12) for v in frame["radial_acceleration"].reshape(-1)
        ],
        "cmb_radius_km": shmodel.CMB_RADIUS,
        "units": {
            "intensity": "µT",
            "decl": "degrees",
            "incl": "degrees",
            "delta_incl": "degrees",
            "radial": "mT",
            "intensity_acceleration": "nT/yr²",
            "radial_acceleration": "nT/yr²",
        },
    }


class FieldModelsPlugin(FiestaPlugin):
    name = "field-models"
    description = (
        "Geomagnetic field models (CALS10k.2, ArchKalmag14k, gufm1, ...): predicted intensity, "
        "VADM, "
        "declination and inclination curves with uncertainty bands and ensembles at chosen or "
        "searched locations with the search's data overlaid, global Mollweide maps and exports."
    )
    Options = FieldModelsOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, FieldModelsOptions)
        levels = {lvl.name: lvl for lvl in node.search.levels}
        if options.base_level not in levels:
            raise ValueError(
                f"plugin 'field-models': base_level {options.base_level!r} is not a search level"
            )
        if levels[options.base_level].table != options.table:
            raise ValueError(
                f"plugin 'field-models': the {options.base_level} level searches "
                f"{levels[options.base_level].table!r}, not {options.table!r}"
            )
        tables = node.load_data_model(node.data_model.latest)["tables"]
        if options.table not in tables:
            raise ValueError(
                f"plugin 'field-models': the data model has no {options.table!r} table"
            )
        columns = tables[options.table]["columns"]
        unknown = [c for c in options.columns.model_dump().values() if c not in columns]
        if unknown:
            raise ValueError(
                f"plugin 'field-models': columns {unknown} are not {options.table} columns"
            )
        if options.default_end_year <= options.default_start_year:
            raise ValueError(
                "plugin 'field-models': default_end_year must be after default_start_year"
            )

    def frontend_config(self, node: NodeConfig) -> dict:
        options = self.options(node)
        assert isinstance(options, FieldModelsOptions)
        return {
            "view": "field-models",
            "base_level": options.base_level,
            "table": options.table,
            "columns": options.columns.model_dump(),
            "defaults": {
                "models": options.default_models,
                "latitude": options.default_latitude,
                "longitude": options.default_longitude,
                "altitude": 0,
                "start_year": options.default_start_year,
                "end_year": options.default_end_year,
                "step": options.default_step,
            },
        }

    def build_router(self) -> APIRouter:
        router = APIRouter()
        plugin = self

        async def catalogue(node: NodeConfig) -> tuple[FieldModelsOptions, dict]:
            options = plugin.options(node)
            assert isinstance(options, FieldModelsOptions)
            catalog = await STORE.catalog(node, options.storage_prefix)
            return options, catalog or {"models": {}, "unavailable": {}}

        def chosen_entries(catalog: dict, names: list[str]) -> list[dict]:
            models = catalog["models"]
            names = list(dict.fromkeys(names))
            missing = [n for n in names if n not in models]
            if missing:
                _fail(f"Unknown field model(s): {', '.join(missing)}.")
            return [models[n] for n in names]

        @router.get("/catalog")
        async def get_catalog(node: NodeDep) -> dict:
            """The installed models, grouped as GEOMAGIA lists them, with their
            interval, uncertainty, ensemble, citation and terms."""
            _, catalog = await catalogue(node)
            entries = list(catalog["models"].values())
            groups = []
            for key, label in DATASET_GROUPS.items():
                names = [e["name"] for e in entries if e["group"] == key and not e.get("legacy")]
                if names:
                    groups.append({"label": label, "models": names})
            legacy = [e["name"] for e in entries if e.get("legacy")]
            if legacy:
                groups.append({"label": "Legacy models", "models": legacy})
            return {
                "installed": bool(entries),
                "groups": groups,
                "models": {
                    e["name"]: {
                        **_metadata(e),
                        "name": e["name"],
                        "start": e["start"],
                        "end": e["end"],
                        "degree": e["degree"],
                        "has_uncertainty": e["has_uncertainty"] or bool(e.get("ensemble")),
                        "file_uncertainty": e["has_uncertainty"],
                    }
                    for e in entries
                },
                "unavailable": catalog.get("unavailable", {}),
                "generated": catalog.get("generated"),
                "limits": {
                    "points_per_curve": shmodel.MAX_POINTS_PER_CURVE,
                    "curves": shmodel.MAX_TOTAL_CURVES,
                    "points": shmodel.MAX_TOTAL_POINTS,
                },
            }

        @router.post("/curves")
        async def post_curves(node: NodeDep, request: CurveRequest) -> dict:
            """Model curves (F, D, I, VADM and file uncertainties) at the
            manual location or the search's site locations."""
            options, catalog = await catalogue(node)
            if not catalog["models"]:
                _fail("No field models are installed for this node.")
            chosen = chosen_entries(catalog, request.models)
            locations, membership, extra, altitude = resolve_locations(request, options)
            windows = validate_window(
                request, chosen, list(catalog["models"].values()), len(locations)
            )
            series = []
            for entry in chosen:
                model = await STORE.model(node, options.storage_prefix, entry)
                series += await asyncio.to_thread(
                    model_curves,
                    model,
                    entry,
                    windows[entry["name"]],
                    request.step,
                    locations,
                    altitude,
                    membership,
                )
            return {
                "series": series,
                "latitude": locations[0][0],
                "longitude": locations[0][1],
                "altitude": altitude,
                "start_year": request.start_year,
                "end_year": request.end_year,
                "step": request.step,
                **extra,
            }

        @router.post("/ensembles")
        async def post_ensembles(node: NodeDep, request: CurveRequest) -> dict:
            """Ensemble standard deviations (and, with include_members, every
            member's curve) for the chosen models that have ensembles."""
            options, catalog = await catalogue(node)
            chosen = chosen_entries(catalog, request.models)
            locations, _, _, altitude = resolve_locations(request, options)
            windows = validate_window(
                request, chosen, list(catalog["models"].values()), len(locations)
            )
            with_members = [e for e in chosen if e.get("ensemble")]
            points = sum(
                (math.ceil((windows[e["name"]][1] - windows[e["name"]][0]) / request.step) + 1)
                * e["ensemble"]["members"]
                * len(locations)
                for e in with_members
            )
            work = sum(
                len(e["ensemble"]["times"])
                * e["ensemble"]["members"]
                * e["degree"]
                * (e["degree"] + 2)
                * len(locations)
                for e in with_members
            )
            if points > MAX_MEMBER_POINTS or work > MAX_SYNTHESIS_TERMS:
                _fail(
                    "The complete ensembles are too large for this calculation. Use median search "
                    "locations, fewer models, a shorter interval or a larger time step."
                )
            series = []
            for entry in with_members:
                cube = await STORE.cube(node, options.storage_prefix, entry)
                series += await asyncio.to_thread(
                    ensemble_curves,
                    cube,
                    entry,
                    windows[entry["name"]],
                    request.step,
                    locations,
                    altitude,
                    request.include_members,
                )
            return {
                "series": series,
                "uncertainty_definition": ENSEMBLE_DEFINITION,
                "member_points": points,
            }

        @router.get("/global")
        async def get_global(node: NodeDep, model: str, year: float) -> dict:
            """The 37 x 72 global grid of one model at one year."""
            options, catalog = await catalogue(node)
            entry = catalog["models"].get(model)
            if (
                entry is None
                or not math.isfinite(year)
                or not entry["start"] <= year <= entry["end"]
            ):
                _fail("Choose a valid model and a year within its available dates.")
            loaded = await STORE.model(node, options.storage_prefix, entry)
            return await asyncio.to_thread(
                _global_cached, loaded, entry["sha256"], year, json.dumps(entry, sort_keys=True)
            )

        return router


_GLOBAL_CACHE: OrderedDict[tuple, dict] = OrderedDict()


def _global_cached(model, digest: str, year: float, entry_json: str) -> dict:
    key = (digest, year)
    if key not in _GLOBAL_CACHE:
        _GLOBAL_CACHE[key] = global_payload(model, json.loads(entry_json), year)
        while len(_GLOBAL_CACHE) > 64:
            _GLOBAL_CACHE.popitem(last=False)
    else:
        _GLOBAL_CACHE.move_to_end(key)
    return _GLOBAL_CACHE[key]
