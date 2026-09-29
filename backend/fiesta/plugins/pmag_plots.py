"""MagIC: interactive PmagPy plots of a contribution.

The legacy MagIC site showed each contribution's PmagPy plots as cached PNGs
(`make_magic_plots.py`: equal area, Zijderveld, demagnetization, Arai,
deremagnetization, ...). This plugin serves the same plots' data instead, so
the contribution view draws them interactively: the measurements are grouped
and paired here, with the few PmagPy (pmag.py) calculations the plots need
ported alongside (dir2cart / cart2dir, dogeo, dotilt, fisher_mean, and the
zero-field/in-field pairing of sortarai), and the frontend projects them.

Every contribution with something to plot gets one `pmag_plots` search doc
whose `summary.pmag_plots` block counts the plots of each type, so the
contribution view shows the tabs and their counts without reading the file;
the plot data itself (GET /contributions/{id}/{kind}) is computed from the
file on demand and cached per contribution revision.
"""

import asyncio
import math
from collections import OrderedDict
from functools import lru_cache
from typing import Any, Literal

from fastapi import APIRouter
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

KELVIN = 273  # as PmagPy converts: MagIC records 100 °C as 373 K
# Measurement method codes of a demagnetization step, and the step's kind.
DEMAG_STEPS = {"LT-NO": "NRM", "LT-AF-Z": "AF", "LT-T-Z": "T", "LT-M-Z": "MW", "LT-LT-Z": "LT"}
# Thellier-type paleointensity steps.
PI_STEPS = {"LT-NO", "LT-T-Z", "LT-T-I", "LT-PTRM-I", "LT-PTRM-MD"}
# Experiments whose steps reuse those codes but are not demagnetization or
# paleointensity (anisotropy, cooling rate, acquisition, hysteresis, ...).
OTHER_EXPERIMENTS = ("LP-AN", "LP-CR", "LP-TRM", "LP-ARM", "LP-IRM", "LP-HYS", "LP-X")
MOMENT_COLUMNS = {"magn_moment": "Am²", "magn_volume": "A/m", "magn_mass": "Am²/kg"}
# dir_tilt_correction -> coordinate system: specimen, geographic, tilt-corrected.
COORDINATES = {-1: "s", 0: "g", 100: "t"}


class PmagPlotsOptions(PluginOptions):
    plot_types: list[PlotType] = Field(
        default=list(PLOT_TYPES),
        description="Plot tabs shown in the contribution view, in order",
    )


# --- pmag.py ports ------------------------------------------------------------------------


def dir2cart(dec: float, inc: float, m: float = 1.0) -> tuple[float, float, float]:
    d, i = math.radians(dec), math.radians(inc)
    return (m * math.cos(d) * math.cos(i), m * math.sin(d) * math.cos(i), m * math.sin(i))


def cart2dir(x: float, y: float, z: float) -> tuple[float, float, float]:
    r = math.sqrt(x * x + y * y + z * z)
    if r == 0:
        return 0.0, 0.0, 0.0
    return math.degrees(math.atan2(y, x)) % 360, math.degrees(math.asin(z / r)), r


def dogeo(dec: float, inc: float, az: float, pl: float) -> tuple[float, float]:
    """Specimen to geographic coordinates, from the sample's azimuth and plunge
    of its X direction (pmag.dogeo)."""
    x = dir2cart(dec, inc)
    a1, a2, a3 = dir2cart(az, pl), dir2cart(az + 90, 0), dir2cart(az - 180, 90 - pl)
    d, i, _ = cart2dir(*(a1[k] * x[0] + a2[k] * x[1] + a3[k] * x[2] for k in range(3)))
    return d, i


def dotilt(dec: float, inc: float, bed_az: float, bed_dip: float) -> tuple[float, float]:
    """Geographic to tilt-corrected coordinates (pmag.dotilt); `bed_az` is the
    dip direction."""
    x = dir2cart(dec, inc)
    sa, ca = -math.sin(math.radians(bed_az)), math.cos(math.radians(bed_az))
    cdp, sdp = math.cos(math.radians(bed_dip)), math.sin(math.radians(bed_dip))
    xc = x[0] * (sa * sa + ca * ca * cdp) + x[1] * (ca * sa * (1 - cdp)) + x[2] * sdp * ca
    yc = x[0] * ca * sa * (1 - cdp) + x[1] * (ca * ca + sa * sa * cdp) - x[2] * sa * sdp
    zc = x[0] * ca * sdp - x[1] * sdp * sa - x[2] * cdp
    d, i, _ = cart2dir(xc, yc, -zc)
    return d, i


def fisher_mean(directions: list[tuple[float, float]]) -> dict | None:
    """Fisher (1953) mean of unit directions: dec, inc, n, r, k and α95 (pmag.fisher_mean)."""
    n = len(directions)
    if n < 2:
        return None
    sums = [0.0, 0.0, 0.0]
    for dec, inc in directions:
        for k, v in enumerate(dir2cart(dec, inc)):
            sums[k] += v
    dec, inc, r = cart2dir(*sums)
    mean: dict[str, Any] = {"dec": _r(dec), "inc": _r(inc), "n": n, "r": _r(r, 4)}
    if n - r > 1e-10:
        mean["k"] = _r((n - 1) / (n - r), 1)
        cos_a95 = 1 - (n - r) / r * (20 ** (1 / (n - 1)) - 1)
        if -1 <= cos_a95 <= 1:
            mean["a95"] = _r(math.degrees(math.acos(cos_a95)))
    return mean


# --- helpers ------------------------------------------------------------------------------


def _r(value: float, digits: int = 2) -> float:
    return round(value, digits)


def _sig(value: float) -> float:
    """Five significant figures: moments span many decades."""
    return float(f"{value:.5g}")


def _num(row: dict, column: str) -> float | None:
    value = to_float(row.get(column))
    return value if value is not None and math.isfinite(value) else None


def _codes(row: dict) -> frozenset[str]:
    return _split_codes(row.get("method_codes") or "")


@lru_cache(maxsize=4096)
def _split_codes(method_codes: str) -> frozenset[str]:
    # A contribution repeats a handful of method-code strings many thousands of times.
    return frozenset(c.strip() for c in method_codes.split(":") if c.strip())


def _any_prefix(codes: frozenset[str], prefixes: tuple[str, ...]) -> bool:
    return any(c.startswith(prefixes) for c in codes)


# Measurements are plotted in the order the file lists them, which is the order
# they were measured: `sequence` and `treat_step_num` are not trusted to reorder
# them, as some files' numbers lost trailing zeros in a spreadsheet (9010
# became 901), which would scramble a hysteresis loop.


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


def _step_value(kind: str, row: dict) -> float | None:
    if kind == "AF":
        return _millitesla(_num(row, "treat_ac_field"))
    if kind in ("T", "LT"):
        return _celsius(_num(row, "treat_temp"))
    if kind == "MW":
        return _num(row, "treat_mw_power")
    return 0.0  # NRM


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


# --- demagnetization (Zijderveld, demagnetization, measurement-level equal area) ----------


def _demag_rows(rows: list[dict]) -> list[dict]:
    """A specimen's directional demagnetization steps: those of its
    non-paleointensity experiments, or else the zero-field steps of its
    paleointensity experiment (as thellier_magic plots them), NRM first."""
    steps = []
    for row in rows:
        codes = _codes(row)
        if not codes & DEMAG_STEPS.keys() or _any_prefix(codes, OTHER_EXPERIMENTS):
            continue
        if _num(row, "dir_dec") is None or _num(row, "dir_inc") is None:
            continue
        steps.append(row)
    pi = [r for r in steps if _any_prefix(_codes(r), ("LP-PI",))]
    pi_ids = {id(r) for r in pi}
    plain = [r for r in steps if id(r) not in pi_ids]
    chosen = plain if any("LT-NO" not in _codes(r) for r in plain) else pi
    if not any("LT-NO" in _codes(r) for r in chosen):
        chosen = [r for r in steps if "LT-NO" in _codes(r)][:1] + chosen
    return chosen


def demag_specimens(parsed: ParsedContribution, hierarchy: _Hierarchy) -> list[dict]:
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

    specimens = []
    for specimen, rows in _by_specimen(parsed.tables.get("measurements", [])).items():
        steps = _demag_rows(rows)
        column = _moment_column(steps)
        if column is None:
            continue
        steps = [r for r in steps if _num(r, column) is not None]
        if len(steps) < 2:
            continue
        kinds = [DEMAG_STEPS[next(c for c in _codes(r) if c in DEMAG_STEPS)] for r in steps]
        decs = [_num(r, "dir_dec") or 0.0 for r in steps]
        incs = [_num(r, "dir_inc") or 0.0 for r in steps]
        item: dict[str, Any] = {
            **hierarchy.of_specimen(specimen),
            "unit": MOMENT_COLUMNS[column],
            "steps": {
                "kind": kinds,
                "value": [_step_value(k, r) for k, r in zip(kinds, steps, strict=True)],
                "dec": [_r(d) for d in decs],
                "inc": [_r(i) for i in incs],
                "m": [_sig(_num(r, column) or 0.0) for r in steps],
                "bad": [int((r.get("quality") or "g") == "b") for r in steps],
            },
            "fits": fits_of.get(specimen, []),
        }
        orientation = hierarchy.orientation.get(item["sample"])
        if orientation:
            geo = [
                dogeo(d, i, orientation["azimuth"], orientation["dip"])
                for d, i in zip(decs, incs, strict=True)
            ]
            item["geo"] = {"dec": [_r(d) for d, _ in geo], "inc": [_r(i) for _, i in geo]}
            if "bed_dip" in orientation and "bed_dip_direction" in orientation:
                tilt = [
                    dotilt(d, i, orientation["bed_dip_direction"], orientation["bed_dip"])
                    for d, i in geo
                ]
                item["tilt"] = {"dec": [_r(d) for d, _ in tilt], "inc": [_r(i) for _, i in tilt]}
        specimens.append(item)
    return specimens


# --- equal area of interpreted directions --------------------------------------------------


def _direction_sets(rows: list[dict], name_column: str) -> dict[str, dict]:
    """Directions by coordinate system, each set with its Fisher mean (of the
    lines; planes are drawn as great circles and left out of the mean)."""
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
        if comp := row.get("dir_comp") or row.get("dir_comp_name"):
            direction["comp"] = comp
        sets.setdefault(_coordinate(row), {"dirs": []})["dirs"].append(direction)
    for entry in sets.values():
        lines = [(d["dec"], d["inc"]) for d in entry["dirs"] if not d.get("plane")]
        if mean := fisher_mean(lines):
            entry["mean"] = mean
    return sets


def eqarea_plots(parsed: ParsedContribution, hierarchy: _Hierarchy) -> list[dict]:
    """Interpreted directions, one plot per group: the sites of each location,
    and the samples and the specimens of each site."""
    plots = []

    def add(level: str, group_level: str, groups: dict[str, list[dict]], name_column: str):
        for group, rows in sorted(groups.items()):
            if sets := _direction_sets(rows, name_column):
                plots.append(
                    {"level": level, "group_level": group_level, "name": group, "sets": sets}
                )

    sites: dict[str, list[dict]] = {}
    for row in parsed.tables.get("sites", []):
        sites.setdefault(row.get("location") or "", []).append(row)
    add("Sites", "location", sites, "site")
    samples: dict[str, list[dict]] = {}
    for row in parsed.tables.get("samples", []):
        samples.setdefault(row.get("site") or "", []).append(row)
    add("Samples", "site", samples, "sample")
    specimens: dict[str, list[dict]] = {}
    for row in parsed.tables.get("specimens", []):
        site = hierarchy.site_of.get(row.get("sample") or "", "")
        specimens.setdefault(site, []).append(row)
    add("Specimens", "site", specimens, "specimen")
    return plots


# --- Thellier-type paleointensity (Arai, deremagnetization) --------------------------------


def _norm(v: tuple[float, float, float]) -> float:
    return math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)


def _minus(a: tuple[float, float, float], b: tuple[float, float, float]):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def arai_specimen(rows: list[dict], interpretation: dict | None) -> dict | None:
    """Pair a specimen's zero-field and in-field steps at each temperature
    (pmag.sortarai): NRM remaining |Z| against pTRM gained |I − Z|, both over
    the NRM; pTRM checks against the zero-field step before them; tail
    checks against the pTRM gained at their temperature."""
    rows = [
        r
        for r in rows
        if _codes(r) & PI_STEPS
        and ("LT-NO" in _codes(r) or _any_prefix(_codes(r), ("LP-PI",)))
        and not _any_prefix(_codes(r), OTHER_EXPERIMENTS)
    ]
    column = _moment_column(rows)
    if column is None:
        return None
    zero: dict[float, tuple[int, tuple]] = {}
    infield: dict[float, tuple[int, tuple]] = {}
    order: dict[float, str] = {}
    checks: list[tuple[float, tuple, float | None]] = []
    tails: list[tuple[float, tuple]] = []
    nrm = None
    lab_field = None
    last_zero: float | None = None
    for index, row in enumerate(rows):
        dec, inc, m = _num(row, "dir_dec"), _num(row, "dir_inc"), _num(row, column)
        temp = _celsius(_num(row, "treat_temp"))
        if dec is None or inc is None or m is None or temp is None:
            continue
        vector = dir2cart(dec, inc, m)
        codes = _codes(row)
        if "LP-PI-TRM-IZ" in codes:
            order[temp] = "IZ"
        elif "LP-PI-TRM-ZI" in codes:
            order[temp] = "ZI"
        if "LT-NO" in codes:
            nrm = nrm or vector
            zero.setdefault(temp, (index, vector))
            last_zero = temp
        elif "LT-T-Z" in codes:
            zero.setdefault(temp, (index, vector))
            last_zero = temp
        elif "LT-T-I" in codes:
            infield.setdefault(temp, (index, vector))
            if lab_field is None and (field := _num(row, "treat_dc_field")) is not None:
                lab_field = field * 1e6
        elif "LT-PTRM-I" in codes:
            checks.append((temp, vector, last_zero))
        elif "LT-PTRM-MD" in codes:
            tails.append((temp, vector))
    if not zero or not infield:
        return None
    nrm0 = _norm(nrm) if nrm else _norm(zero[min(zero)][1])
    if nrm0 == 0:
        return None

    points: dict[float, tuple[float, float]] = {}
    steps: dict[str, list] = {"t": [], "x": [], "y": [], "order": []}
    for temp in sorted(zero):
        z_index, z = zero[temp]
        if temp in infield:
            i_index, i = infield[temp]
            x = _norm(_minus(i, z)) / nrm0
            step_order = order.get(temp) or ("ZI" if z_index < i_index else "IZ")
        elif nrm and z is nrm:
            x, step_order = 0.0, "NRM"
        else:
            continue
        y = _norm(z) / nrm0
        points[temp] = (x, y)
        for key, value in (("t", temp), ("x", _r(x, 5)), ("y", _r(y, 5)), ("order", step_order)):
            steps[key].append(value)
    if len(steps["t"]) < 2:
        return None

    ptrm_checks: dict[str, list] = {"t": [], "t_from": [], "x": [], "y": []}
    for temp, vector, before in checks:
        if before is None or before not in zero:
            continue
        z = zero[before][1]
        for key, value in (
            ("t", temp),
            ("t_from", before),
            ("x", _r(_norm(_minus(vector, z)) / nrm0, 5)),
            ("y", _r(_norm(z) / nrm0, 5)),
        ):
            ptrm_checks[key].append(value)
    tail_checks: dict[str, list] = {"t": [], "x": [], "y": []}
    for temp, vector in tails:
        if temp in points:
            for key, value in (
                ("t", temp),
                ("x", _r(points[temp][0], 5)),
                ("y", _r(_norm(vector) / nrm0, 5)),
            ):
                tail_checks[key].append(value)

    item: dict[str, Any] = {
        "unit": MOMENT_COLUMNS[column],
        "nrm0": _sig(nrm0),
        "lab_field": _r(lab_field, 3) if lab_field is not None else None,
        "steps": steps,
        "ptrm_checks": ptrm_checks,
        "tail_checks": tail_checks,
    }
    if interpretation:
        item["fit"] = _arai_fit(points, interpretation, lab_field)
    return item


def _arai_fit(
    points: dict[float, tuple[float, float]], row: dict, lab_field: float | None
) -> dict | None:
    """The published interpretation's temperature bounds, intensity and the
    correction factors it applied, with the Arai slope over those steps (Coe
    et al. 1978: b = −√(Σδy²/Σδx²)) and the intensity it gives, corrected by
    the same factors."""
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
    chosen = [xy for t, xy in points.items() if low - 0.5 <= t <= high + 0.5]
    if len(chosen) < 2:
        return fit
    n = len(chosen)
    mx = sum(x for x, _ in chosen) / n
    my = sum(y for _, y in chosen) / n
    sxx = sum((x - mx) ** 2 for x, _ in chosen)
    syy = sum((y - my) ** 2 for _, y in chosen)
    sxy = sum((x - mx) * (y - my) for x, y in chosen)
    if sxx == 0:
        return fit
    b = math.copysign(math.sqrt(syy / sxx), sxy)
    fit.update({"n": n, "b": _r(b, 5), "x_mean": _r(mx, 5), "y_mean": _r(my, 5)})
    if lab_field is not None:
        fit["int_calc"] = _r(abs(b) * lab_field * math.prod(corrections.values()), 2)
    return fit


def arai_specimens(parsed: ParsedContribution, hierarchy: _Hierarchy) -> list[dict]:
    interpretations: dict[str, dict] = {}
    for row in parsed.tables.get("specimens", []):
        if row.get("specimen") and _num(row, "int_abs") is not None:
            interpretations.setdefault(row["specimen"], row)
    specimens = []
    for specimen, rows in _by_specimen(parsed.tables.get("measurements", [])).items():
        item = arai_specimen(rows, interpretations.get(specimen))
        if item:
            specimens.append({**hierarchy.of_specimen(specimen), **item})
    return specimens


# --- hysteresis loops ----------------------------------------------------------------------


def hysteresis_loops(parsed: ParsedContribution, hierarchy: _Hierarchy) -> list[dict]:
    loops: dict[tuple[str, str], list[dict]] = {}
    for row in parsed.tables.get("measurements", []):
        if (
            row.get("specimen")
            and "LP-HYS" in _codes(row)
            and _num(row, "meas_field_dc") is not None
        ):
            loops.setdefault((row["specimen"], row.get("experiment") or ""), []).append(row)
    items = []
    for (specimen, experiment), rows in loops.items():
        column = _moment_column(rows)
        if column is None:
            continue
        rows = [r for r in rows if _num(r, column) is not None]
        if len(rows) < 10:
            continue
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


def compute_plots(parsed: ParsedContribution) -> dict[str, Any]:
    """Every kind of plot data for a contribution, and the count of each plot type."""
    hierarchy = _Hierarchy(parsed)
    demag = demag_specimens(parsed, hierarchy)
    eqarea = eqarea_plots(parsed, hierarchy)
    arai = arai_specimens(parsed, hierarchy)
    hyst = hysteresis_loops(parsed, hierarchy)
    return {
        "demag": {"specimens": demag},
        "eqarea": {"plots": eqarea},
        "arai": {"specimens": arai},
        "hyst": {"loops": hyst},
        "counts": {
            "eqarea": len(eqarea) + len(demag),
            "zijd": len(demag),
            "demag": len(demag),
            "arai": len(arai),
            "deremag": len(arai),
            "hyst": len(hyst),
        },
    }


# Recently computed contributions, by node, id and revision: a contribution's
# tabs each ask for one kind, and the file is parsed once for all of them.
_CACHE: OrderedDict[tuple, dict[str, Any]] = OrderedDict()
_CACHE_SIZE = 8


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
        counts = compute_plots(parsed)["counts"]
        if not any(counts.values()):
            return []
        return [
            {
                "type": "pmag_plots",
                "summary": {"contribution": contribution_meta, "pmag_plots": counts, "_all": {}},
            }
        ]

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/contributions/{contribution_id}/{kind}")
        async def get_plots(
            session: SessionDep,
            node: NodeDep,
            contribution_id: int,
            kind: Kind,
            private_key: str | None = None,
        ) -> dict:
            """One kind of plot data for a contribution: `demag` (steps per
            specimen, with their fits), `eqarea` (interpreted directions per
            location or site, with Fisher means), `arai` (paired Thellier steps
            per specimen) or `hyst` (hysteresis loops)."""
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
                raw = await load_file(node, contribution.id, contribution.filename)
                plots = await asyncio.to_thread(
                    lambda: compute_plots(parse_text(raw.decode("utf-8", errors="replace")))
                )
                _CACHE[key] = plots
                while len(_CACHE) > _CACHE_SIZE:
                    _CACHE.popitem(last=False)
            _CACHE.move_to_end(key)
            return plots[kind]

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        return {"table": "pmag_plots", **self.options(node).model_dump()}
