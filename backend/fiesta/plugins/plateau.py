"""KArAr: ⁴⁰Ar/³⁹Ar age plateaus over step-heating experiments.

Python port of the legacy KArAr `PlateauCalculations` class (client-side JS).
Per-step ages come from the ⁴⁰Ar*/³⁹ArK ratio via the standard age equation;
the plateau is the lowest-MSWD run of ≥3 consecutive steps spanning ≥50% of
cumulative ³⁹Ar release with MSWD ≤ 2.5.

Constants (legacy values, quoted from plateau_calculations.js):
    atmospheric ⁴⁰Ar/³⁶Ar = 295.5
    default total decay constant λ = 5.543e-10 / year
    default J value = 1e-3
"""

import math
from typing import Any

from fastapi import APIRouter, HTTPException

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin
from fiesta.plugins.util import load_visible_parsed, to_float

ATM_AR40_AR36 = 295.5
DEFAULT_LAMBDA = 5.543e-10  # 1/years
DEFAULT_J = 1e-3

MIN_PLATEAU_STEPS = 3
MAX_MSWD = 2.5
MIN_AR39_PERCENT = 50.0

TEMP_COLUMNS = ["measurement_step_heat_temperature", "temperature", "temp", "step_temperature"]
AR39_COLUMNS = [
    "corrected_39ar_potassium",
    "measurement_ar39_vol_stp",
    "ar39_vol",
    "intercept_39ar",  # raw ³⁹Ar intercept (real KArAr 1.0 data)
]


def experiment_matches(row_experiment: str | None, requested: str) -> bool:
    """Experiment identifiers can differ between the experiments table and the
    measurements table (e.g. "33922-01" vs "33922"); match either direction on
    a hyphen-delimited prefix."""
    if not row_experiment:
        return False
    if row_experiment == requested:
        return True
    return requested.startswith(f"{row_experiment}-") or row_experiment.startswith(f"{requested}-")


def _get(row: dict, *columns: str) -> float | None:
    return next((v for c in columns if (v := to_float(row.get(c))) is not None), None)


def calculate_age(
    row: dict, j_value: float = DEFAULT_J, lam: float = DEFAULT_LAMBDA
) -> dict | None:
    """Per-step age (Ma) and 1σ from a measurement row, or None if the row
    lacks usable isotope data."""
    # Pre-computed ages take precedence.
    age = to_float(row.get("age"))
    age_sigma = to_float(row.get("age_sigma_analytical"))
    if age is not None and age_sigma is not None:
        return {
            "age": age,
            "age_sigma": age_sigma,
            "ar40rad_ar39": None,
            "ar40rad_ar39_sigma": None,
        }

    ar36_ar39 = _get(row, "total_36ar_39ar_ratio", "measurement_36ar_39ar_ratio")
    ar36_ar39_sigma = _get(
        row, "total_36ar_39ar_ratio_sigma", "measurement_36ar_39ar_ratio_sigma"
    )
    ar40_ar39 = to_float(row.get("measurement_40ar_39ar_ratio"))
    ar40_ar39_sigma = to_float(row.get("measurement_40ar_39ar_ratio_sigma"))

    ar40rad_ar39: float | None = None
    ar40rad_ar39_sigma: float | None = None

    # KArAr 1.0 provides the radiogenic ratio directly.
    direct = to_float(row.get("corrected_40ar_rad_39ar_k_ratio"))
    if direct is not None:
        ar40rad_ar39 = direct
        ar40rad_ar39_sigma = to_float(row.get("corrected_40ar_rad_39ar_k_ratio_sigma"))
    elif ar40_ar39 is not None and ar36_ar39 is not None:
        # Atmospheric correction: 40Ar*/39Ar = 40/39 - 295.5 * 36/39
        ar40rad_ar39 = ar40_ar39 - ATM_AR40_AR36 * ar36_ar39
        if ar40_ar39_sigma is not None and ar36_ar39_sigma is not None:
            ar40rad_ar39_sigma = math.sqrt(
                ar40_ar39_sigma**2 + (ATM_AR40_AR36 * ar36_ar39_sigma) ** 2
            )
    else:
        rad40 = to_float(row.get("corrected_40ar_radiogenic"))
        k39 = to_float(row.get("corrected_39ar_potassium"))
        if rad40 is not None and k39 not in (None, 0):
            ar40rad_ar39 = rad40 / k39
            rad40_sigma = to_float(row.get("corrected_40ar_radiogenic_sigma"))
            k39_sigma = to_float(row.get("corrected_39ar_potassium_sigma"))
            if rad40_sigma is not None and k39_sigma is not None and rad40 != 0:
                ar40rad_ar39_sigma = abs(ar40rad_ar39) * math.sqrt(
                    (rad40_sigma / rad40) ** 2 + (k39_sigma / k39) ** 2
                )

    if ar40rad_ar39 is None or ar40rad_ar39 <= 0:
        return None

    # Age equation: t = (1/λ) ln(1 + J * 40Ar*/39ArK), reported in Ma.
    age = (1.0 / lam) * math.log(1.0 + j_value * ar40rad_ar39) / 1e6
    age_sigma = (
        age * ar40rad_ar39_sigma / ar40rad_ar39 if ar40rad_ar39_sigma is not None else 0.0
    )
    return {
        "age": age,
        "age_sigma": age_sigma,
        "ar40rad_ar39": ar40rad_ar39,
        "ar40rad_ar39_sigma": ar40rad_ar39_sigma,
    }


def cumulative_ar39_percent(rows: list[dict]) -> list[float]:
    amounts = [(_get(row, *AR39_COLUMNS) or 0.0) for row in rows]
    total = sum(amounts)
    if total <= 0:
        # Fall back to equal-release steps so plots still render.
        n = len(rows)
        return [100.0 * (i + 1) / n for i in range(n)] if n else []
    cumulative: list[float] = []
    running = 0.0
    for amount in amounts:
        running += amount
        cumulative.append(100.0 * running / total)
    return cumulative


def weighted_mean(steps: list[dict]) -> dict | None:
    usable = [s for s in steps if s["age_sigma"] and s["age_sigma"] > 0]
    if not usable:
        return None
    weights = [1.0 / s["age_sigma"] ** 2 for s in usable]
    total_weight = sum(weights)
    mean = sum(w * s["age"] for w, s in zip(weights, usable, strict=True)) / total_weight
    mswd = (
        sum(w * (s["age"] - mean) ** 2 for w, s in zip(weights, usable, strict=True))
        / (len(usable) - 1)
        if len(usable) > 1
        else 0.0
    )
    return {
        "weighted_mean": mean,
        "uncertainty": math.sqrt(1.0 / total_weight),
        "mswd": mswd,
    }


def identify_plateau(age_data: list[dict]) -> dict | None:
    """Lowest-MSWD run of >= MIN_PLATEAU_STEPS consecutive steps spanning
    >= MIN_AR39_PERCENT of cumulative 39Ar with MSWD <= MAX_MSWD."""
    n = len(age_data)
    best: dict | None = None
    for start in range(n):
        for end in range(start + MIN_PLATEAU_STEPS - 1, n):
            span_start = age_data[start - 1]["cum_ar39"] if start > 0 else 0.0
            ar39_span = age_data[end]["cum_ar39"] - span_start
            if ar39_span < MIN_AR39_PERCENT:
                continue
            stats = weighted_mean(age_data[start : end + 1])
            if stats is None or stats["mswd"] > MAX_MSWD:
                continue
            if best is None or stats["mswd"] < best["mswd"]:
                best = {
                    "plateau_steps": list(range(start, end + 1)),
                    "plateau_age": stats["weighted_mean"],
                    "plateau_age_sigma": stats["uncertainty"],
                    "mswd": stats["mswd"],
                    "ar39_percent": ar39_span,
                }
    return best


def deduplicate(rows: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    unique: list[dict] = []
    for row in rows:
        key = tuple(
            row.get(c)
            for c in (
                *TEMP_COLUMNS,
                "measurement_40ar_39ar_ratio",
                "total_36ar_39ar_ratio",
                "corrected_40ar_radiogenic",
                "age",
            )
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(row)
    return unique


def process_plateau_data(
    rows: list[dict], j_value: float = DEFAULT_J, lam: float = DEFAULT_LAMBDA
) -> dict:
    """Main entry point: raw measurement rows -> age spectrum + plateau."""
    total_steps = len(rows)
    rows = deduplicate(rows)
    rows.sort(key=lambda r: _get(r, *TEMP_COLUMNS) or 0.0)

    age_data: list[dict[str, Any]] = []
    for i, row in enumerate(rows):
        result = calculate_age(row, j_value, lam)
        if result is None:
            continue
        age_data.append(
            {
                "step": len(age_data) + 1,
                "temperature": _get(row, *TEMP_COLUMNS),
                "age": result["age"],
                "age_sigma": result["age_sigma"],
                "ar40rad_ar39": result["ar40rad_ar39"],
                "original_index": i,
            }
        )
    cumulative = cumulative_ar39_percent([rows[d["original_index"]] for d in age_data])
    for entry, cum in zip(age_data, cumulative, strict=True):
        entry["cum_ar39"] = cum

    return {
        "age_data": age_data,
        "plateau": identify_plateau(age_data),
        "total_steps": total_steps,
        "unique_steps": len(rows),
        "duplicates_removed": total_steps - len(rows),
    }


class PlateauPlugin(FiestaPlugin):
    name = "plateau-calculations"

    def build_router(self, node: NodeConfig) -> APIRouter:
        router = APIRouter()

        @router.get("/contributions/{contribution_id}/experiments/{experiment}/plateau")
        async def get_plateau(
            session: SessionDep,
            node: NodeDep,
            contribution_id: int,
            experiment: str,
            private_key: str | None = None,
            j_value: float = DEFAULT_J,
            decay_constant: float = DEFAULT_LAMBDA,
        ) -> dict:
            _, parsed = await load_visible_parsed(session, node, contribution_id, private_key)
            rows = [
                row
                for row in parsed.tables.get("measurements", [])
                if experiment_matches(row.get("experiment"), experiment)
            ]
            if not rows:
                raise HTTPException(
                    404, f"no measurements for experiment {experiment!r} in {contribution_id}"
                )
            return process_plateau_data(rows, j_value, decay_constant)

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        return {
            "view": "age-spectrum",
            # The age-spectrum thumbnail/modal attaches to these levels'
            # result items, keyed by the row's experiment name.
            "levels": ["Experiments"],
            "constants": {
                "atm_ar40_ar36": ATM_AR40_AR36,
                "default_lambda": DEFAULT_LAMBDA,
                "default_j": DEFAULT_J,
                "min_plateau_steps": MIN_PLATEAU_STEPS,
                "max_mswd": MAX_MSWD,
                "min_ar39_percent": MIN_AR39_PERCENT,
            },
        }
