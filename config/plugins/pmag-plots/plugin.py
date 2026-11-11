"""MagIC: interactive PmagPy plots of a contribution.

The legacy MagIC site showed each contribution's PmagPy plots as cached PNGs
(`make_magic_plots.py`: equal area, Zijderveld, demagnetization, Arai,
deremagnetization, ...). This plugin serves the same plots' data instead, so
the contribution view draws them interactively, and PmagPy (`pmagpy.pmag`)
does the science: `find_dmag_rec` reads the demagnetization steps,
`dogeo_V` / `dotilt_V` rotate them, `dir2cart` gives the Zijderveld
components, `fisher_mean` averages directions, `sortarai` pairs the Thellier
steps and `int_pars` fits the Arai slope, and `dimap_V` / `circ` place every
direction, α95 circle and plane on the equal-area net, split into lower and
upper hemisphere as `pmagplotlib.plot_di` / `plot_circ` split them. The
frontend only draws the coordinates it is sent.

What stays here is what PmagPy has no function for: grouping the tables by
the specimen → sample → site → location hierarchy, choosing each specimen's
rows (PmagPy's scripts filter whole files the same way), cleaning legacy rows
PmagPy would raise on (blank treatments, moments or directions), restoring
hysteresis `sequence` numbers that lost their trailing zeros, and shaping
the compact payload.

Every contribution with something to plot gets one `pmag_plots` search doc
whose `summary.pmag_plots` block counts the plots of each type, so the
contribution view shows the tabs and their counts without reading the file;
the counts take the same row selection without calling PmagPy. The plot
data itself (GET /contributions/{id}/{kind}) is computed from the file on
demand and cached per contribution revision. The same doc carries one small
thumbnail per plot type (`compute_thumbnails`, under `_geometry`), which the
search grid's Plot tile draws with the total count, as the legacy grid showed
one cached PNG and a count.
"""

import asyncio
import gzip
import json
import logging
import math
import random
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from functools import lru_cache
from typing import Any, Literal

import numpy as np
from fastapi import APIRouter, Request, Response
from pmagpy import pmag
from pydantic import Field

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.domain.parse import ParsedContribution, parse_text
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions
from fiesta.plugins.util import load_visible_contribution, to_float
from fiesta.services.contributions import load_file

# The plot tabs, in the legacy order. Each is drawn from one data `kind`:
# Zijderveld, demagnetization and the measurement-level equal area plots from
# the demagnetization steps; Arai and deremagnetization from the paired
# Thellier steps.
PLOT_TYPES = ["eqarea", "zijd", "demag", "arai", "deremag", "hyst"]
PlotType = Literal["eqarea", "zijd", "demag", "arai", "deremag", "hyst"]
Kind = Literal["demag", "eqarea", "arai", "hyst"]

logger = logging.getLogger(__name__)

KELVIN = 273  # as PmagPy converts: MagIC records 100 °C as 373 K
# The demagnetization steps pmag.find_dmag_rec reads, and each one's kind
# (when a row has several, the last one listed sets its treatment, as there).
DEMAG_STEPS = {"LT-NO": "NRM", "LT-AF-Z": "AF", "LT-T-Z": "T", "LT-M-Z": "MW"}
# Thellier-type paleointensity steps (pmag.sortarai).
PI_STEPS = {"LT-NO", "LT-T-Z", "LT-T-I", "LT-PTRM-I", "LT-PTRM-MD"}
# Experiments whose steps reuse those codes but are not demagnetization or
# paleointensity (anisotropy, cooling rate, acquisition, hysteresis, ...): a
# superset of find_dmag_rec's excluded protocols.
OTHER_EXPERIMENTS = ("LP-AN", "LP-CR", "LP-TRM", "LP-ARM", "LP-IRM", "LP-HYS", "LP-X")
MOMENT_COLUMNS = {"magn_moment": "Am²", "magn_volume": "A/m", "magn_mass": "Am²/kg"}
# dir_tilt_correction -> coordinate system: specimen, geographic, tilt-corrected.
COORDINATES = {-1: "s", 0: "g", 100: "t"}
# Points on a plane's great circle and on an α95 circle (pmag.circ draws
# 201): chords of 4° and 6° around the circle, each well under a pixel from
# the curve on the largest plot.
GREAT_CIRCLE_POINTS = 91
SMALL_CIRCLE_POINTS = 61


class PmagPlotsOptions(PluginOptions):
    plot_types: list[PlotType] = Field(
        default=list(PLOT_TYPES),
        description="Plot tabs shown in the contribution view, in order",
    )


# --- helpers ------------------------------------------------------------------------------


def _r(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


def _sig(value: float, figures: int = 5) -> float:
    """Significant figures: moments span many decades."""
    return float(f"{float(value):.{figures}g}")


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _num(row: dict, column: str) -> float | None:
    value = to_float(row.get(column))
    return value if value is not None and math.isfinite(value) else None


def _num_or(row: dict, column: str, default: Any) -> Any:
    value = _num(row, column)
    return default if value is None else value


def _codes(row: dict) -> frozenset[str]:
    return _split_codes(row.get("method_codes") or "")


@lru_cache(maxsize=4096)
def _split_codes(method_codes: str) -> frozenset[str]:
    # A contribution repeats a handful of method-code strings many thousands of times.
    return frozenset(c.strip() for c in method_codes.split(":") if c.strip())


def _any_prefix(codes: frozenset[str], prefixes: tuple[str, ...]) -> bool:
    return any(c.startswith(prefixes) for c in codes)


# Demagnetization and Thellier steps are plotted in the order the file lists
# them; a hysteresis loop in `sequence` order (see hysteresis_loops).


def _by_sequence(rows: list[dict]) -> list[dict]:
    """Rows in `sequence` order when every row has one, else as listed (a
    stable sort, so repeated numbers keep their file order).

    Some files' numbers lost their trailing zeros in a spreadsheet (…9009,
    901, 9011… and 1500 as 15): a number that times 10, 100, … is exactly one
    more than the row before (one less than the row after, for the first) is
    read as that number."""
    keys = [_num(r, "sequence") for r in rows]
    if any(k is None for k in keys):
        return rows
    fixed: list[float] = []
    for key in keys:
        assert key is not None
        expected = fixed[-1] + 1 if fixed else (keys[1] or 0) - 1 if len(keys) > 1 else key
        if key != expected:
            key = next((key * 10**k for k in range(1, 7) if key * 10**k == expected), key)
        fixed.append(key)
    return [r for _, r in sorted(zip(fixed, rows, strict=True), key=lambda kr: kr[0])]


def _moment_column(rows: list[dict]) -> str | None:
    """The magnetization column most of these rows have."""
    counts = {c: sum(_num(r, c) is not None for r in rows) for c in MOMENT_COLUMNS}
    column = max(counts, key=lambda c: counts[c])
    return column if counts[column] else None


def _celsius(kelvin: float | None) -> float | None:
    return None if kelvin is None else _r(kelvin - KELVIN, 1)


def _millitesla(tesla: float | None) -> float | None:
    """T to mT; values over 1 T were already recorded in mT (no AF
    demagnetizer reaches 1 T)."""
    if tesla is None:
        return None
    return _r(tesla if abs(tesla) > 1 else tesla * 1e3, 2)


def _step_unit_value(value: float | None, unit: str | None) -> float | None:
    """A meas_step_min/max in the plots' units (°C, mT)."""
    if value is None:
        return None
    if unit == "K":
        return _celsius(value)
    if unit == "T":
        return _millitesla(value)
    return value


def _coordinate(row: dict) -> str:
    tc = _num(row, "dir_tilt_correction")
    return COORDINATES.get(int(tc), "g") if tc is not None else "g"


def _fit_type(codes: frozenset[str]) -> str:
    if _any_prefix(codes, ("DE-BFP",)):
        return "plane"
    if _any_prefix(codes, ("DE-FM",)):
        return "mean"
    return "line"


class _Hierarchy:
    """specimen -> sample -> site -> location, and each sample's orientation."""

    def __init__(self, parsed: ParsedContribution):
        self.sample_of = {
            r["specimen"]: r.get("sample", "")
            for r in parsed.tables.get("specimens", [])
            if r.get("specimen")
        }
        self.site_of = {
            r["sample"]: r.get("site", "")
            for r in parsed.tables.get("samples", [])
            if r.get("sample")
        }
        self.location_of = {
            r["site"]: r.get("location", "")
            for r in parsed.tables.get("sites", [])
            if r.get("site")
        }
        self.orientation: dict[str, dict[str, float]] = {}
        for r in parsed.tables.get("samples", []):
            values = {c: _num(r, c) for c in ("azimuth", "dip", "bed_dip_direction", "bed_dip")}
            if r.get("sample") and values["azimuth"] is not None and values["dip"] is not None:
                self.orientation[r["sample"]] = {k: v for k, v in values.items() if v is not None}

    def of_specimen(self, specimen: str) -> dict[str, str]:
        sample = self.sample_of.get(specimen, "")
        site = self.site_of.get(sample, "")
        return {
            "specimen": specimen,
            "sample": sample,
            "site": site,
            "location": self.location_of.get(site, ""),
        }


def _by_specimen(rows: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for row in rows:
        if row.get("specimen"):
            groups.setdefault(row["specimen"], []).append(row)
    return groups


class _Records(list):
    """A specimen's measurement records for PmagPy's data model 3 functions,
    which take a DataFrame only to call `.to_dict("records")` on it; building
    one per specimen would cost more than the science."""

    def to_dict(self, orient: str = "records") -> list[dict]:
        return [dict(record) for record in self]


# --- the equal-area net (pmag.dimap_V, pmag.circ) ------------------------------------------


def _xy(decs, incs) -> list[list[float]]:
    """Equal-area positions (pmag.dimap_V): x east, y north, radius 1 on the
    horizontal; upper-hemisphere directions at their own azimuth, as PmagPy
    plots them (drawn open). A vertical direction is the centre."""
    if len(decs) == 0:
        return []
    with np.errstate(all="ignore"):
        xy = pmag.dimap_V(np.asarray(decs, dtype=float), np.asarray(incs, dtype=float))
    xy = np.nan_to_num(np.atleast_2d(xy), nan=0.0)
    return [[round(float(x), 3), round(float(y), 3)] for x, y in xy]


def _circle(dec: float, inc: float, radius: float) -> list[dict]:
    """A small circle of `radius`° about a direction (90° gives the great
    circle of a plane from its pole, pmag.circ), as runs of projected points
    on one hemisphere each; pmagplotlib.plot_circ puts a point with I < 0 on
    the upper one. Each run starts where the last ended, so the circle stays
    joined."""
    points = GREAT_CIRCLE_POINTS if radius >= 90 else SMALL_CIRCLE_POINTS
    with np.errstate(all="ignore"):
        decs, incs = pmag.circ(dec, inc, radius, points)
    runs: list[dict] = []
    for point, i in zip(_xy(decs, incs), incs, strict=True):
        lower = bool(i >= 0)
        if runs and runs[-1]["lower"] == lower:
            runs[-1]["points"].append(point)
        else:
            joined = [runs[-1]["points"][-1], point] if runs else [point]
            runs.append({"lower": lower, "points": joined})
    if len(runs) > 1 and runs[0]["lower"] == runs[-1]["lower"]:
        # pmag.circ ends where it starts: the last run carries on into the first.
        runs[-1]["points"] += runs.pop(0)["points"][1:]
    return runs


@lru_cache(maxsize=1)
def net() -> dict[str, list]:
    """The net as pmagplotlib.plot_net draws it: the rim, a tick from 0 to 3°
    every 10° around it, and a cross every 10° of inclination along the four
    axes (the centre's included)."""
    rim = _xy(np.arange(0, 361.0), np.zeros(361))
    ticks = [[a, b] for a, *_, b in (_xy([d] * 4, range(4)) for d in range(0, 360, 10))]
    half = 0.02
    for dec, top in ((0, 100), (90, 90), (180, 90), (270, 90)):
        for x, y in _xy([dec] * len(range(10, top, 10)), range(10, top, 10)):
            ticks.append([[round(x - half, 3), y], [round(x + half, 3), y]])
            ticks.append([[x, round(y - half, 3)], [x, round(y + half, 3)]])
    return {"rim": rim, "ticks": ticks}


# --- demagnetization (Zijderveld, demagnetization, measurement-level equal area) ----------


def _demag_kind(codes: frozenset[str]) -> str | None:
    kinds = [kind for code, kind in DEMAG_STEPS.items() if code in codes]
    return kinds[-1] if kinds else None


def _demag_rows(rows: list[dict]) -> tuple[list[dict], str] | None:
    """A specimen's directional demagnetization steps and the moment column:
    those of its non-paleointensity experiments, or else the zero-field steps
    of its paleointensity experiment (as thellier_magic plots them), NRM
    first, without pTRM checks (as zeq_magic leaves them out) and without the
    rows pmag.find_dmag_rec would raise on."""
    steps = []
    for row in rows:
        codes = _codes(row)
        kind = _demag_kind(codes)
        if kind is None or _any_prefix(codes, OTHER_EXPERIMENTS + ("LT-PTRM",)):
            continue
        if _num(row, "dir_dec") is None or _num(row, "dir_inc") is None:
            continue
        # A step without its treatment (find_dmag_rec raises on a blank
        # temperature and plots a blank field at 0 mT) is left out.
        if kind == "T" and _num(row, "treat_temp") is None:
            continue
        if kind == "AF" and _num(row, "treat_ac_field") is None:
            continue
        if kind == "MW" and None in (_num(row, "treat_mw_power"), _num(row, "treat_mw_time")):
            continue
        steps.append(row)
    pi = [r for r in steps if _any_prefix(_codes(r), ("LP-PI",))]
    pi_ids = {id(r) for r in pi}
    plain = [r for r in steps if id(r) not in pi_ids]
    chosen = plain if any("LT-NO" not in _codes(r) for r in plain) else pi
    if not any("LT-NO" in _codes(r) for r in chosen):
        chosen = [r for r in steps if "LT-NO" in _codes(r)][:1] + chosen
    column = _moment_column(chosen)
    if column is None:
        return None
    chosen = [r for r in chosen if _num(r, column) is not None]
    return (chosen, column) if len(chosen) >= 2 else None


def _dmag_block(rows: list[dict], column: str) -> tuple[list[list], str] | None:
    """pmag.find_dmag_rec over a specimen's chosen rows: one
    [treatment, dec, inc, moment, ZI, flag, instrument] per row, with the
    treatment in T, K or J and the units found."""
    records = [
        {
            "specimen": "s",
            "method_codes": row.get("method_codes") or "",
            # A blank NRM temperature is the room temperature PmagPy assumes.
            "treat_temp": _num_or(row, "treat_temp", KELVIN if "LT-NO" in _codes(row) else ""),
            "treat_ac_field": _num_or(row, "treat_ac_field", ""),
            "treat_mw_power": _num_or(row, "treat_mw_power", ""),
            "treat_mw_time": _num_or(row, "treat_mw_time", ""),
            "dir_dec": _num(row, "dir_dec"),
            "dir_inc": _num(row, "dir_inc"),
            column: _num(row, column),
            "flag": "b" if (row.get("quality") or "g") == "b" else "g",
        }
        for row in rows
    ]
    try:
        block, units = pmag.find_dmag_rec("s", _Records(records), version=3)
    except (TypeError, ValueError, KeyError):
        return None
    if len(block) != len(rows) or any(b[1] == "" or b[2] == "" or b[3] == "" for b in block):
        return None
    return block, units


def _step_value(kind: str, treatment: float, units: str) -> float | None:
    """A find_dmag_rec treatment in the plots' units: mT, °C, J. It records
    an AF run's room-temperature NRM as 0 and a thermal run's 0 as 273 K."""
    if kind == "AF":
        return _millitesla(treatment)
    if kind == "T":
        return _celsius(treatment) if treatment >= KELVIN else 0.0
    if kind == "MW":
        return _r(treatment, 2)
    return _celsius(treatment) if units == "K" and treatment >= KELVIN else 0.0  # NRM


def _coords_block(decs, incs, relative) -> dict[str, list[float]]:
    """A specimen's steps in one coordinate system: direction, equal-area
    position, and the north, east and down components (pmag.dir2cart) the
    Zijderveld plot projects, over the NRM as pmagplotlib.plot_zij
    normalizes them."""
    cart = np.atleast_2d(pmag.dir2cart(np.column_stack([decs, incs, relative])))
    xy = _xy(decs, incs)
    return {
        "dec": [_r(d, 1) for d in decs],
        "inc": [_r(i, 1) for i in incs],
        "x": [p[0] for p in xy],
        "y": [p[1] for p in xy],
        "n": [_r(v, 4) for v in cart[:, 0]],
        "e": [_r(v, 4) for v in cart[:, 1]],
        "d": [_r(v, 4) for v in cart[:, 2]],
    }


def _fit_geometry(fit: dict, coords: dict, values: list, bad: list) -> None:
    """What a fit draws in its coordinate system: a line's or mean's point
    on the net, a plane's great circle, and a line's dashed Zijderveld line
    through the steps it spans, along its direction."""
    if fit["type"] == "plane":
        fit["circle"] = _circle(fit["dec"], fit["inc"], 90)
        return
    fit["xy"] = _xy([fit["dec"]], [fit["inc"]])[0]
    block = coords.get(fit["coord"])
    if fit["type"] != "line" or block is None:
        return
    vectors = np.column_stack([block["n"], block["e"], block["d"]])
    chosen = [
        k
        for k, value in enumerate(values)
        if not bad[k]
        and value is not None
        and (fit["min"] is None or value >= fit["min"] - 1e-6)
        and (fit["max"] is None or value <= fit["max"] + 1e-6)
    ]
    if len(chosen) < 2:
        return
    centre = vectors[chosen].mean(axis=0)
    # Long enough to cross the plot, which clips it.
    length = 3 * float(np.linalg.norm(vectors, axis=1).max())
    direction = np.asarray(pmag.dir2cart([fit["dec"], fit["inc"], length]), dtype=float)
    fit["zijd"] = [[_r(v, 4) for v in centre + sign * direction] for sign in (-1, 1)]


def _fits_of(parsed: ParsedContribution) -> dict[str, list[dict]]:
    fits_of: dict[str, list[dict]] = {}
    for row in parsed.tables.get("specimens", []):
        dec, inc = _num(row, "dir_dec"), _num(row, "dir_inc")
        if not row.get("specimen") or dec is None or inc is None:
            continue
        unit = row.get("meas_step_unit")
        fit = {
            "coord": _coordinate(row),
            "type": _fit_type(_codes(row)),
            "dec": dec,
            "inc": inc,
            "min": _step_unit_value(_num(row, "meas_step_min"), unit),
            "max": _step_unit_value(_num(row, "meas_step_max"), unit),
            "comp": row.get("dir_comp") or row.get("dir_comp_name") or "",
            "mad": _num(row, "dir_mad_free"),
        }
        fits_of.setdefault(row["specimen"], []).append(fit)
    return fits_of


def demag_specimen(rows: list[dict], orientation: dict | None, fits: list[dict]) -> dict | None:
    selected = _demag_rows(rows)
    if selected is None:
        return None
    steps, column = selected
    found = _dmag_block(steps, column)
    if found is None:
        return None
    block, units = found
    kinds = [_demag_kind(_codes(r)) or "NRM" for r in steps]
    decs = np.array([b[1] for b in block], dtype=float)
    incs = np.array([b[2] for b in block], dtype=float)
    moments = np.array([b[3] for b in block], dtype=float)
    values = [_step_value(k, float(b[0]), units) for k, b in zip(kinds, block, strict=True)]
    bad = [int(b[5] == "b") for b in block]
    relative = moments / (moments[0] or moments.max() or 1)
    coords = {"s": _coords_block(decs, incs, relative)}
    if orientation:
        n = len(decs)
        az, pl = orientation["azimuth"], orientation["dip"]
        gdecs, gincs = pmag.dogeo_V(np.column_stack([decs, incs, [az] * n, [pl] * n]))
        coords["g"] = _coords_block(gdecs, gincs, relative)
        if "bed_dip" in orientation and "bed_dip_direction" in orientation:
            bed_az, bed_dip = orientation["bed_dip_direction"], orientation["bed_dip"]
            tdecs, tincs = pmag.dotilt_V(
                np.column_stack([gdecs, gincs, [bed_az] * n, [bed_dip] * n])
            )
            coords["t"] = _coords_block(tdecs, tincs, relative)
    fits = [dict(fit) for fit in fits]
    for fit in fits:
        _fit_geometry(fit, coords, values, bad)
    return {
        "unit": MOMENT_COLUMNS[column],
        "steps": {
            "kind": kinds,
            "value": values,
            "m": [_sig(m) for m in moments],
            "bad": bad,
        },
        "coords": coords,
        "fits": fits,
    }


def demag_specimens(parsed: ParsedContribution, hierarchy: _Hierarchy) -> list[dict]:
    fits_of = _fits_of(parsed)
    specimens = []
    for specimen, rows in _by_specimen(parsed.tables.get("measurements", [])).items():
        where = hierarchy.of_specimen(specimen)
        item = demag_specimen(
            rows, hierarchy.orientation.get(where["sample"]), fits_of.get(specimen, [])
        )
        if item:
            specimens.append({**where, **item})
    return specimens


# --- equal area of interpreted directions --------------------------------------------------


def fisher_mean(directions: list[tuple[float, float]]) -> dict | None:
    """pmag.fisher_mean of two or more directions: dec, inc, n, r, k and α95
    (180° when the directions are too scattered for a cone)."""
    if len(directions) < 2:
        return None
    pars = pmag.fisher_mean([[dec, inc] for dec, inc in directions])
    mean: dict[str, Any] = {
        "dec": _r(pars["dec"]),
        "inc": _r(pars["inc"]),
        "n": int(pars["n"]),
        "r": _r(pars["r"], 4),
    }
    if (k := _finite(pars.get("k"))) is not None:
        mean["k"] = _r(k, 1)
    if (a95 := _finite(pars.get("alpha95"))) is not None:
        mean["a95"] = _r(a95)
    return mean


def _direction_sets(rows: list[dict], name_column: str) -> dict[str, dict]:
    """Directions by coordinate system, each set with its Fisher mean (of the
    lines; planes are drawn as great circles and left out of the mean), and
    where each is drawn on the net."""
    sets: dict[str, dict] = {}
    for row in rows:
        dec, inc = _num(row, "dir_dec"), _num(row, "dir_inc")
        if dec is None or inc is None:
            continue
        direction: dict[str, Any] = {"name": row.get(name_column, ""), "dec": dec, "inc": inc}
        if (a95 := _num(row, "dir_alpha95")) is not None:
            direction["a95"] = a95
        if _fit_type(_codes(row)) == "plane":
            direction["plane"] = True
            direction["circle"] = _circle(dec, inc, 90)
        else:
            direction["xy"] = _xy([dec], [inc])[0]
        if comp := row.get("dir_comp") or row.get("dir_comp_name"):
            direction["comp"] = comp
        sets.setdefault(_coordinate(row), {"dirs": []})["dirs"].append(direction)
    for entry in sets.values():
        lines = [(d["dec"], d["inc"]) for d in entry["dirs"] if not d.get("plane")]
        if mean := fisher_mean(lines):
            mean["xy"] = _xy([mean["dec"]], [mean["inc"]])[0]
            if 0 < mean.get("a95", 0) < 180:
                mean["circle"] = _circle(mean["dec"], mean["inc"], mean["a95"])
            entry["mean"] = mean
    return sets


def _direction_groups(parsed: ParsedContribution, hierarchy: _Hierarchy):
    """(level, group level, group name, rows, name column) of each equal-area
    plot: the sites of each location, and the samples and the specimens of
    each site."""
    sites: dict[str, list[dict]] = {}
    for row in parsed.tables.get("sites", []):
        sites.setdefault(row.get("location") or "", []).append(row)
    samples: dict[str, list[dict]] = {}
    for row in parsed.tables.get("samples", []):
        samples.setdefault(row.get("site") or "", []).append(row)
    specimens: dict[str, list[dict]] = {}
    for row in parsed.tables.get("specimens", []):
        site = hierarchy.site_of.get(row.get("sample") or "", "")
        specimens.setdefault(site, []).append(row)
    for level, group_level, groups, name_column in (
        ("Sites", "location", sites, "site"),
        ("Samples", "site", samples, "sample"),
        ("Specimens", "site", specimens, "specimen"),
    ):
        for group, rows in sorted(groups.items()):
            yield level, group_level, group, rows, name_column


def _has_direction(rows: list[dict]) -> bool:
    return any(_num(r, "dir_dec") is not None and _num(r, "dir_inc") is not None for r in rows)


def eqarea_plots(parsed: ParsedContribution, hierarchy: _Hierarchy) -> list[dict]:
    """Interpreted directions, one plot per group."""
    plots = []
    for level, group_level, group, rows, name_column in _direction_groups(parsed, hierarchy):
        if sets := _direction_sets(rows, name_column):
            plots.append({"level": level, "group_level": group_level, "name": group, "sets": sets})
    return plots


# --- Thellier-type paleointensity (Arai, deremagnetization) --------------------------------


def _arai_rows(rows: list[dict]) -> tuple[list[dict], str] | None:
    """A specimen's Thellier steps, as thellier_magic selects them (rows of
    an LP-PI-TRM experiment, so not the anisotropy or cooling-rate steps that
    reuse LT-T-I), its NRM first, cleaned of what pmag.sortarai would raise
    on or misread: rows without a temperature, direction or moment, NRMs
    after the first, tail checks without a zero-field step at their
    temperature, and a pTRM check with no step before it."""
    pi = [
        r
        for r in rows
        if _codes(r) & PI_STEPS
        and _any_prefix(_codes(r), ("LP-PI-TRM",))
        and not _any_prefix(_codes(r), OTHER_EXPERIMENTS)
    ]
    if not any("LT-NO" in _codes(r) for r in pi):
        pi = [r for r in rows if "LT-NO" in _codes(r)][:1] + pi
    column = _moment_column(pi)
    if column is None:
        return None
    clean = []
    for row in pi:
        nrm = "LT-NO" in _codes(row)
        if any(_num(row, c) is None for c in ("dir_dec", "dir_inc", column)):
            continue
        # A blank NRM temperature is the room temperature PmagPy assumes.
        if _num(row, "treat_temp") is None and not nrm:
            continue
        if nrm and any("LT-NO" in _codes(r) for r in clean):
            continue
        clean.append(row)
    zero = {_temp(r) for r in clean if _codes(r) & {"LT-NO", "LT-T-Z"}}
    clean = [r for r in clean if not ("LT-PTRM-MD" in _codes(r) and _temp(r) not in zero)]
    # sortarai's baseline for a pTRM check is the record before it.
    while clean and "LT-PTRM-I" in _codes(clean[0]):
        clean.pop(0)
    return clean, column


def _temp(row: dict) -> float:
    """A cleaned Thellier row's temperature in K (an NRM's room temperature
    when blank)."""
    return _num_or(row, "treat_temp", float(KELVIN))


def _in_field(codes: frozenset[str]) -> bool:
    """An in-field step as sortarai takes one."""
    return "LT-T-I" in codes and "LP-PI-TRM" in codes and "LP-TRM" not in codes


def _arai_temperatures(rows: list[dict]) -> list[float]:
    """The temperatures sortarai pairs (its first_Z): the NRM's 273 K, then
    each in-field step's that has a zero-field step, in in-field order."""
    zero = {_temp(r) for r in rows if _codes(r) & {"LT-NO", "LT-T-Z"}}
    temps = [float(KELVIN)] if any("LT-NO" in _codes(r) for r in rows) else []
    for row in rows:
        if _in_field(_codes(row)) and (temp := _temp(row)) in zero:
            temps.append(temp)
    return list(dict.fromkeys(temps))


def _sortarai(rows: list[dict], column: str):
    """pmag.sortarai(..., version=3) over a specimen's cleaned rows."""
    records = [
        {
            "specimen": "s",
            "method_codes": r.get("method_codes") or "",
            "treat_temp": _temp(r),
            "dir_dec": _num(r, "dir_dec"),
            "dir_inc": _num(r, "dir_inc"),
            column: _num(r, column),
            # Only the lab field's direction (sortarai's gamma check) needs these.
            "treat_dc_field": _num_or(r, "treat_dc_field", math.nan),
            "treat_dc_field_phi": _num_or(r, "treat_dc_field_phi", 0.0),
            "treat_dc_field_theta": _num_or(r, "treat_dc_field_theta", 0.0),
        }
        for r in rows
    ]
    try:
        with np.errstate(all="ignore"):
            return pmag.sortarai(_Records(records), "s", 0, version=3)
    except (TypeError, ValueError, KeyError, IndexError, ZeroDivisionError):
        return None


def arai_specimen(rows: list[dict], interpretation: dict | None) -> dict | None:
    """A specimen's Arai plot as pmagplotlib.plot_arai draws sortarai's
    pairing: NRM remaining (each first zero-field step) against pTRM gained
    (|in-field − zero-field|), both over the NRM; pTRM checks (|check − the
    record before it|) at the NRM remaining of their temperature; tail checks
    (|tail| − |zero-field|) at the pTRM gained of theirs."""
    selected = _arai_rows(rows)
    if selected is None or len(_arai_temperatures(selected[0])) < 2:
        return None
    clean, column = selected
    result = _sortarai(clean, column)
    if result is None:
        return None
    (first_z, first_i, ptrm_check, ptrm_tail, *_), field = result
    if not first_z or not _finite(first_z[0][3]):
        return None
    nrm0 = float(first_z[0][3])
    has_nrm = any("LT-NO" in _codes(r) for r in clean)

    def first(block: list, temp: float) -> list | None:
        # plot_arai's lookups: the first record at that temperature.
        return next((rec for rec in block if rec[0] == temp), None)

    points: dict[float, tuple[float, float]] = {}
    steps: dict[str, list] = {"t": [], "x": [], "y": [], "order": []}
    for k, z in enumerate(first_z):
        temp = float(z[0])
        i = first(first_i, temp)
        if temp in points or i is None:
            continue
        x, y = float(i[3]) / nrm0, float(z[3]) / nrm0
        points[temp] = (x, y)
        order = "NRM" if k == 0 and has_nrm else "ZI" if z[4] == 1 else "IZ"
        for key, value in (
            ("t", _celsius(temp)),
            ("x", _r(x, 5)),
            ("y", _r(y, 5)),
            ("order", order),
        ):
            steps[key].append(value)
    if len(steps["t"]) < 2:
        return None

    # sortarai's pTRM-check baseline is the record before the first check at
    # that temperature.
    before: dict[float, float] = {}
    # plot_arai finds a check's NRM remaining among the paired steps (and
    # takes the last one when none is at its temperature): a zero-field step
    # with no in-field partner serves instead.
    remaining: dict[float, float] = {}
    for k, row in enumerate(clean):
        temp = _temp(row)
        if "LT-PTRM-I" in _codes(row):
            before.setdefault(temp, _temp(clean[k - 1]))
        elif "LT-T-Z" in _codes(row):
            remaining.setdefault(temp, _num(row, column) or 0.0)
    ptrm_checks: dict[str, list] = {"t": [], "t_from": [], "x": [], "y": []}
    for check in ptrm_check:
        temp = float(check[0])
        z = first(first_z, temp)
        y = float(z[3]) if z is not None else remaining.get(temp)
        if y is None or _celsius(temp) in ptrm_checks["t"]:
            continue
        for key, value in (
            ("t", _celsius(temp)),
            ("t_from", _celsius(before.get(temp, temp))),
            ("x", _r(float(check[3]) / nrm0, 5)),
            ("y", _r(y / nrm0, 5)),
        ):
            ptrm_checks[key].append(value)
    tail_checks: dict[str, list] = {"t": [], "x": [], "y": []}
    for tail in ptrm_tail:
        temp = float(tail[0])
        i = first(first_i, temp)
        if i is None or _celsius(temp) in tail_checks["t"]:
            continue
        for key, value in (
            ("t", _celsius(temp)),
            ("x", _r(float(i[3]) / nrm0, 5)),
            ("y", _r(float(tail[3]) / nrm0, 5)),
        ):
            tail_checks[key].append(value)

    # sortarai's lab field is its first in-field step's; a blank one there
    # takes the next step's.
    lab_field = _finite(field)
    if lab_field is None:
        fields = (_num(r, "treat_dc_field") for r in clean if _in_field(_codes(r)))
        lab_field = next((f for f in fields if f is not None), None)
    lab_field = lab_field * 1e6 if lab_field is not None else None
    item: dict[str, Any] = {
        "unit": MOMENT_COLUMNS[column],
        "nrm0": _sig(nrm0),
        "lab_field": _r(lab_field, 3) if lab_field is not None else None,
        "steps": steps,
        "ptrm_checks": ptrm_checks,
        "tail_checks": tail_checks,
    }
    if interpretation:
        vds = float(pmag.dovds([[z[1], z[2], z[3] / nrm0] for z in first_z]))
        item["fit"] = _arai_fit(points, interpretation, lab_field, vds)
    return item


def _arai_fit(
    points: dict[float, tuple[float, float]], row: dict, lab_field: float | None, vds: float
) -> dict:
    """The published interpretation's temperature bounds, intensity and the
    correction factors it applied, with pmag.int_pars over those steps (the
    York slope b and its σ, f, g, q; three steps or more, as PmagPy needs),
    the line it draws, and the intensity |b|·Blab corrected by the same
    factors."""
    unit = row.get("meas_step_unit") or "K"
    low = _step_unit_value(_num(row, "meas_step_min"), unit)
    high = _step_unit_value(_num(row, "meas_step_max"), unit)
    int_abs = _num(row, "int_abs")
    corrections = {
        name: value
        for name in ("aniso", "cooling_rate", "nlt", "arm")
        if (value := _num(row, f"int_corr_{name}")) is not None
    }
    fit: dict[str, Any] = {
        "min": low,
        "max": high,
        "int_abs": _r(int_abs * 1e6, 2) if int_abs is not None else None,
        "corrections": corrections,
    }
    if low is None or high is None:
        return fit
    chosen = [xy for t, xy in points.items() if low - 0.5 <= t - KELVIN <= high + 0.5]
    xs, ys = [x for x, _ in chosen], [y for _, y in chosen]
    if len(chosen) < 3 or max(xs) == min(xs):
        return fit
    try:
        with np.errstate(all="ignore"):
            pars, error = pmag.int_pars(xs, ys, vds, version=3)
    except ZeroDivisionError:
        return fit
    b = _finite(pars.get("int_b"))
    if error or b is None:
        return fit
    fit.update({"n": len(chosen), "b": _r(b, 5)})
    for key, name, digits in (
        ("b_sigma", "int_b_sigma", 5),
        ("f", "int_f", 3),
        ("g", "int_g", 3),
        ("q", "int_q", 2),
    ):
        if (value := _finite(pars.get(name))) is not None:
            fit[key] = _r(value, digits)
    x_mean, y_mean = sum(xs) / len(xs), sum(ys) / len(ys)
    pad = (max(xs) - min(xs)) * 0.08
    fit["line"] = [
        [_r(x, 5), _r(y_mean + b * (x - x_mean), 5)] for x in (min(xs) - pad, max(xs) + pad)
    ]
    if lab_field is not None:
        fit["int_calc"] = _r(abs(b) * lab_field * math.prod(corrections.values()), 2)
    return fit


def _interpretations(parsed: ParsedContribution) -> dict[str, dict]:
    interpretations: dict[str, dict] = {}
    for row in parsed.tables.get("specimens", []):
        if row.get("specimen") and _num(row, "int_abs") is not None:
            interpretations.setdefault(row["specimen"], row)
    return interpretations


def arai_specimens(parsed: ParsedContribution, hierarchy: _Hierarchy) -> list[dict]:
    interpretations = _interpretations(parsed)
    specimens = []
    for specimen, rows in _by_specimen(parsed.tables.get("measurements", [])).items():
        item = arai_specimen(rows, interpretations.get(specimen))
        if item:
            specimens.append({**hierarchy.of_specimen(specimen), **item})
    return specimens


# --- hysteresis loops ----------------------------------------------------------------------


def _hysteresis_groups(parsed: ParsedContribution):
    loops: dict[tuple[str, str], list[dict]] = {}
    for row in parsed.tables.get("measurements", []):
        if (
            row.get("specimen")
            and "LP-HYS" in _codes(row)
            and _num(row, "meas_field_dc") is not None
        ):
            loops.setdefault((row["specimen"], row.get("experiment") or ""), []).append(row)
    for (specimen, experiment), rows in loops.items():
        column = _moment_column(rows)
        if column is None:
            continue
        rows = [r for r in _by_sequence(rows) if _num(r, column) is not None]
        if len(rows) >= 10:
            yield specimen, experiment, column, rows


def hysteresis_loops(parsed: ParsedContribution, hierarchy: _Hierarchy) -> list[dict]:
    """Each loop's moments against the applied field, in `sequence` order
    (PmagPy's plot_hys draws the loop as measured; nothing to compute)."""
    items = []
    for specimen, experiment, column, rows in _hysteresis_groups(parsed):
        fields = [_num(r, "meas_field_dc") or 0.0 for r in rows]
        # Fields over 5 T are loops recorded in mT.
        scale = 1 if max(abs(f) for f in fields) > 5 else 1e3
        items.append(
            {
                **hierarchy.of_specimen(specimen),
                "experiment": experiment,
                "unit": MOMENT_COLUMNS[column],
                "field": [_r(f * scale, 3) for f in fields],
                "m": [_sig(_num(r, column) or 0.0) for r in rows],
            }
        )
    return items


# --- all together --------------------------------------------------------------------------


def _counts(demag: int, eqarea: int, arai: int, hyst: int) -> dict[str, int]:
    return {
        "eqarea": eqarea + demag,
        "zijd": demag,
        "demag": demag,
        "arai": arai,
        "deremag": arai,
        "hyst": hyst,
    }


KINDS: tuple[Kind, ...] = ("demag", "eqarea", "arai", "hyst")


def compute_kind(parsed: ParsedContribution, hierarchy: _Hierarchy, kind: Kind) -> dict:
    """One kind of plot data, as GET /contributions/{id}/{kind} serves it."""
    if kind == "demag":
        return {"net": net(), "specimens": demag_specimens(parsed, hierarchy)}
    if kind == "eqarea":
        return {"net": net(), "plots": eqarea_plots(parsed, hierarchy)}
    if kind == "arai":
        return {"specimens": arai_specimens(parsed, hierarchy)}
    return {"loops": hysteresis_loops(parsed, hierarchy)}


def compute_plots(parsed: ParsedContribution) -> dict[str, Any]:
    """Every kind of plot data for a contribution, and the count of each plot type."""
    hierarchy = _Hierarchy(parsed)
    plots: dict[str, Any] = {kind: compute_kind(parsed, hierarchy, kind) for kind in KINDS}
    plots["counts"] = _counts(
        len(plots["demag"]["specimens"]),
        len(plots["eqarea"]["plots"]),
        len(plots["arai"]["specimens"]),
        len(plots["hyst"]["loops"]),
    )
    return plots


def compute_counts(parsed: ParsedContribution) -> dict[str, int]:
    """The count of each plot type from the same row selection as
    compute_plots, without the PmagPy calls (search indexing runs this for
    every contribution)."""
    return _PlotIndex(parsed).counts()


# --- grid thumbnails ----------------------------------------------------------------------

THUMBNAIL_POINTS = 150
_TRIES = 5  # candidates tried per kind before giving up on it


def _thin(values: list, limit: int = THUMBNAIL_POINTS) -> list:
    """Every nth value, keeping the last, so a long loop still closes."""
    if len(values) <= limit:
        return values
    step = (len(values) - 1) / (limit - 1)
    return [values[round(i * step)] for i in range(limit)]


def _zijd_thumbnail(specimen: str, rows: list[dict], hierarchy: _Hierarchy) -> dict | None:
    orientation = hierarchy.orientation.get(hierarchy.sample_of.get(specimen, ""))
    item = demag_specimen(rows, orientation, [])
    if item is None:
        return None
    coords = item["coords"].get("g") or item["coords"]["s"]
    return {"name": specimen, **{k: _thin([_r(v, 3) for v in coords[k]]) for k in "ned"}}


def _eqarea_thumbnail(group: tuple) -> dict | None:
    _level, _group_level, name, rows, name_column = group
    sets = _direction_sets(rows, name_column)
    found = next((sets[c] for c in ("g", "t", "s") if c in sets), None)
    lines = [d for d in (found or {}).get("dirs", []) if "xy" in d]
    if not lines:
        return None
    lines = _thin(lines)
    return {
        "name": name,
        "x": [_r(d["xy"][0], 3) for d in lines],
        "y": [_r(d["xy"][1], 3) for d in lines],
        "up": [int(d["inc"] < 0) for d in lines],
    }


def _arai_thumbnail(specimen: str, rows: list[dict]) -> dict | None:
    item = arai_specimen(rows, None)
    if item is None:
        return None
    steps = item["steps"]
    return {"name": specimen, "x": _thin(steps["x"]), "y": _thin(steps["y"])}


def _hyst_thumbnail(loop: tuple) -> dict | None:
    specimen, _experiment, column, rows = loop
    fields = [_num(r, "meas_field_dc") or 0.0 for r in rows]
    moments = [_num(r, column) or 0.0 for r in rows]
    scale = max(map(abs, moments)) or 1.0
    return {
        "name": specimen,
        "field": _thin([_sig(f, 3) for f in fields]),
        "m": _thin([_r(m / scale, 3) for m in moments]),
    }


# The levels whose records the grid's Plot tile draws, by the column naming them.
RECORD_LEVELS = {
    "locations": "location",
    "sites": "site",
    "samples": "sample",
    "specimens": "specimen",
}


class _PlotIndex:
    """What a contribution has to plot, by record: the specimens with
    demagnetization or Thellier steps, the hysteresis loops, and the
    equal-area groups (a location's sites, a site's samples and specimens),
    selected as compute_plots selects them but without PmagPy, which runs
    only for the records a thumbnail draws."""

    def __init__(self, parsed: ParsedContribution):
        self.hierarchy = _Hierarchy(parsed)
        self.by_specimen = _by_specimen(parsed.tables.get("measurements", []))
        specimens = sorted(self.by_specimen)
        self.demag = [s for s in specimens if _demag_rows(self.by_specimen[s]) is not None]
        self.arai = []
        for specimen in specimens:
            selected = _arai_rows(self.by_specimen[specimen])
            if selected is not None and len(_arai_temperatures(selected[0])) >= 2:
                self.arai.append(specimen)
        self.hyst = list(_hysteresis_groups(parsed))
        self.groups = [g for g in _direction_groups(parsed, self.hierarchy) if _has_direction(g[3])]

    def _subset(self, table: str, name: str) -> tuple[list, list, list, list]:
        """(demag specimens, Arai specimens, loops, equal-area groups) of one
        record, or of the whole contribution."""
        if table == "contribution":
            return self.demag, self.arai, self.hyst, self.groups
        column = RECORD_LEVELS.get(table)
        if column is None or not name:
            return [], [], [], []

        def below(specimen: str) -> bool:
            return self.hierarchy.of_specimen(specimen)[column] == name

        location_of = self.hierarchy.location_of
        groups = [
            g
            for g in self.groups
            if (column in ("site", "location") and g[1] == column and g[2] == name)
            or (column == "location" and g[1] == "site" and location_of.get(g[2]) == name)
        ]
        return (
            [s for s in self.demag if below(s)],
            [s for s in self.arai if below(s)],
            [loop for loop in self.hyst if below(loop[0])],
            groups,
        )

    def counts(self, table: str = "contribution", name: str = "") -> dict[str, int]:
        demag, arai, hyst, groups = self._subset(table, name)
        return _counts(len(demag), len(groups), len(arai), len(hyst))

    def thumbnails(self, seed: Any, table: str = "contribution", name: str = "") -> dict:
        """One plot of each type, its record chosen at random (seeded, so the
        same one is drawn again), reduced to the points the search grid's
        100px Plot tile draws: a specimen's Zijderveld projections
        (geographic when oriented), a group's equal-area directions, a
        specimen's Arai steps and a hysteresis loop (moments over their
        maximum). Only the chosen records go through PmagPy, and a type that
        fails is left out."""
        demag, arai, hyst, groups = self._subset(table, name)
        rng = random.Random(f"{seed}" if table == "contribution" else f"{seed}:{table}:{name}")
        by_specimen, hierarchy = self.by_specimen, self.hierarchy
        candidates: dict[str, tuple[list, Callable[[Any], dict | None]]] = {
            "zijd": (demag, lambda s: _zijd_thumbnail(s, by_specimen[s], hierarchy)),
            "eqarea": (groups, _eqarea_thumbnail),
            "arai": (arai, lambda s: _arai_thumbnail(s, by_specimen[s])),
            "hyst": (hyst, _hyst_thumbnail),
        }
        thumbnails: dict[str, dict] = {}
        for plot_type, (items, build) in candidates.items():
            for item in rng.sample(items, min(_TRIES, len(items))):
                try:
                    if thumbnail := build(item):
                        thumbnails[plot_type] = thumbnail
                        break
                except Exception:
                    logger.exception("pmag-plots: the %s thumbnail failed", plot_type)
        return thumbnails

    def record(self, seed: Any, table: str, name: str) -> dict:
        """A record's plot counts and thumbnails, as the grid's Plot tile asks."""
        return {
            "counts": self.counts(table, name),
            "thumbnails": self.thumbnails(seed, table, name),
        }


def compute_thumbnails(parsed: ParsedContribution, seed: Any) -> dict[str, dict]:
    """The contribution's thumbnails, one per plot type (search indexing)."""
    return _PlotIndex(parsed).thumbnails(seed)


# --- serving ------------------------------------------------------------------------------


def _json_default(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def encode(data: dict) -> tuple[bytes, bytes]:
    """A kind's response body, as JSON and gzipped, encoded once per revision
    (FastAPI's encoder took longer than the gzip on the large ones)."""
    body = json.dumps(
        data, separators=(",", ":"), ensure_ascii=False, allow_nan=False, default=_json_default
    ).encode()
    return body, gzip.compress(body, compresslevel=6)


def _parse(raw: bytes) -> tuple[ParsedContribution, _Hierarchy]:
    parsed = parse_text(raw.decode("utf-8", errors="replace"))
    return parsed, _Hierarchy(parsed)


class _Plots:
    """One contribution revision's plot data. A kind is computed when it is
    first asked for, and concurrent requests for it share that computation;
    once one kind has been served the others are computed in the background,
    one at a time, so the contribution's other tabs open at once. The parsed
    file is kept only until every kind is encoded."""

    def __init__(self, read: Callable[[], Awaitable[bytes]]):
        self._read = read
        self._source: asyncio.Task | None = None
        self._kinds: dict[str, asyncio.Task] = {}
        self._warming: asyncio.Task | None = None

    async def _parsed(self) -> tuple[ParsedContribution, _Hierarchy]:
        if self._source is None:
            self._source = asyncio.create_task(self._load())
        source = self._source
        try:
            return await asyncio.shield(source)
        except Exception:
            if self._source is source:
                self._source = None  # retried by the next request
            raise

    async def _load(self) -> tuple[ParsedContribution, _Hierarchy]:
        return await asyncio.to_thread(_parse, await self._read())

    async def _compute(self, kind: Kind) -> tuple[bytes, bytes]:
        parsed, hierarchy = await self._parsed()
        return await asyncio.to_thread(lambda: encode(compute_kind(parsed, hierarchy, kind)))

    async def _encoded(self, kind: Kind) -> tuple[bytes, bytes]:
        task = self._kinds.get(kind)
        if task is None:
            task = self._kinds[kind] = asyncio.create_task(self._compute(kind))
        try:
            # Shielded: a client that disconnects must not cancel the others' wait.
            return await asyncio.shield(task)
        except Exception:
            if self._kinds.get(kind) is task:
                del self._kinds[kind]  # retried by the next request
            raise

    async def get(self, kind: Kind) -> tuple[bytes, bytes]:
        encoded = await self._encoded(kind)
        if self._warming is None:
            self._warming = asyncio.create_task(self._warm())
        return encoded

    async def _warm(self) -> None:
        for kind in KINDS:
            try:
                await self._encoded(kind)
            except Exception:
                logger.exception("pmag-plots: computing %s in the background failed", kind)
        if len(self._kinds) == len(KINDS):  # failed kinds were dropped: keep the source
            self._source = None


# Recently viewed contributions, by node, id and revision.
_CACHE: OrderedDict[tuple, _Plots] = OrderedDict()
_CACHE_SIZE = 8

# The grid's Plot tiles: the last few contributions' plot indexes (each holds
# its parsed file), and every record's answer, small, kept much longer.
_INDEXES: OrderedDict[tuple, asyncio.Task] = OrderedDict()
_INDEXES_SIZE = 4
_RECORDS: OrderedDict[tuple, bytes] = OrderedDict()
_RECORDS_SIZE = 10_000


async def _plot_index(key: tuple, read: Callable[[], Awaitable[bytes]]) -> _PlotIndex:
    """A contribution's plot index, built once for the requests that share it."""
    task = _INDEXES.get(key)
    if task is None:

        async def build() -> _PlotIndex:
            raw = await read()
            return await asyncio.to_thread(lambda: _PlotIndex(_parse(raw)[0]))

        task = _INDEXES[key] = asyncio.create_task(build())
        while len(_INDEXES) > _INDEXES_SIZE:
            _INDEXES.popitem(last=False)
    _INDEXES.move_to_end(key)
    try:
        # Shielded: a client that disconnects must not cancel the others' wait.
        return await asyncio.shield(task)
    except Exception:
        if _INDEXES.get(key) is task:
            del _INDEXES[key]  # retried by the next request
        raise


RecordTable = Literal["contribution", "locations", "sites", "samples", "specimens"]


class PmagPlotsPlugin(FiestaPlugin):
    name = "pmag-plots"
    description = (
        "Interactive PmagPy plots of a contribution (equal area, Zijderveld, "
        "demagnetization, Arai, deremagnetization, hysteresis) as tabs of its view, "
        "with a count of each."
    )
    Options = PmagPlotsOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        tables = node.load_data_model(node.data_model.latest)["tables"]
        missing = [t for t in ("measurements", "specimens", "samples", "sites") if t not in tables]
        if missing:
            raise ValueError(f"plugin 'pmag-plots': the data model has no {missing} tables")

    def search_tables(self, node: NodeConfig) -> list[str]:
        return ["pmag_plots"]

    def derive_docs(
        self, node: NodeConfig, parsed: ParsedContribution, contribution_meta: dict
    ) -> list[dict]:
        index = _PlotIndex(parsed)
        counts = index.counts()
        if not any(counts.values()):
            return []
        # The grid's Plot tile draws one of these (`_geometry`: stored, never indexed).
        thumbnails = index.thumbnails(contribution_meta.get("id"))
        block: dict[str, Any] = {**counts, "_geometry": {"thumbnails": thumbnails}}
        return [
            {
                "type": "pmag_plots",
                "summary": {"contribution": contribution_meta, "pmag_plots": block, "_all": {}},
            }
        ]

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/thumbnails/{contribution_id}")
        async def get_thumbnails(
            session: SessionDep,
            node: NodeDep,
            contribution_id: int,
            table: RecordTable = "contribution",
            name: str = "",
            private_key: str | None = None,
        ) -> Response:
            """A search record's Plot tile: `counts` of its plots by type and
            `thumbnails`, one small plot per type (a random specimen's,
            group's or loop's), for the contribution or one of its locations,
            sites, samples or specimens (`table`, `name`). The index keeps the
            contribution's; a record's are computed from the file on first
            request and kept."""
            contribution = await load_visible_contribution(
                session, node, contribution_id, private_key
            )
            key = (
                node.node.slug,
                contribution.id,
                contribution.head_revision,
                contribution.filename,
                contribution.updated_at,
            )
            body = _RECORDS.get((key, table, name))
            if body is None:
                index = await _plot_index(
                    key, lambda: load_file(node, contribution.id, contribution.filename)
                )
                data = await asyncio.to_thread(index.record, contribution.id, table, name)
                body = json.dumps(data, default=_json_default, separators=(",", ":")).encode()
                _RECORDS[(key, table, name)] = body
                while len(_RECORDS) > _RECORDS_SIZE:
                    _RECORDS.popitem(last=False)
            _RECORDS.move_to_end((key, table, name))
            return Response(body, media_type="application/json")

        @router.get("/contributions/{contribution_id}/{kind}")
        async def get_plots(
            request: Request,
            session: SessionDep,
            node: NodeDep,
            contribution_id: int,
            kind: Kind,
            private_key: str | None = None,
        ) -> Response:
            """One kind of plot data for a contribution: `demag` (steps per
            specimen in each coordinate system, with their fits), `eqarea`
            (interpreted directions per location or site, with Fisher means),
            both with the equal-area net and every position on it; `arai`
            (paired Thellier steps per specimen) or `hyst` (hysteresis loops)."""
            contribution = await load_visible_contribution(
                session, node, contribution_id, private_key
            )
            key = (
                node.node.slug,
                contribution.id,
                contribution.head_revision,
                contribution.filename,
                contribution.updated_at,
            )
            plots = _CACHE.get(key)
            if plots is None:
                plots = _CACHE[key] = _Plots(
                    lambda: load_file(node, contribution.id, contribution.filename)
                )
                while len(_CACHE) > _CACHE_SIZE:
                    _CACHE.popitem(last=False)
            _CACHE.move_to_end(key)
            body, gzipped = await plots.get(kind)
            headers = {"Vary": "Accept-Encoding"}
            if "gzip" in request.headers.get("accept-encoding", ""):
                headers["Content-Encoding"] = "gzip"
                body = gzipped
            return Response(body, media_type="application/json", headers=headers)

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        return {"table": "pmag_plots", **self.options(node).model_dump()}
