"""KArAr: ⁴⁰Ar/³⁹Ar age spectra, isochrons and specimen ages, as contributed.

Every value drawn comes from the contribution; nothing is refitted.

- Step ages: `measurements.age` ± `age_sigma_analytical`.
- Plateau, isochron and total-fusion ages: the `experiments` rows, one per
  `age_calculation_method`, with the steps each one used (`age_steps`, the
  measurement names). The isochron lines come from those rows'
  `40ar_39ar_ratio` and `40ar_36ar_ratio` intercepts.
- Isochron points: the measurements' corrected isochron ratios, with their
  sigmas and error correlations.
- Specimen ages: the `specimens` row's preferred age over the experiments in
  its `age_experiments`.

The legacy KArAr client (plateau_calculations.js) worked differently. It
recomputed step ages with an assumed J of 1e-3 and searched for its own
plateau, so its plots disagreed with the published ages.

The only arithmetic here is presentation. Each step's share of the
experiment's ³⁹Ar release is taken from the first ³⁹Ar column that every step
fills, normalised to 100%. Steps are ordered by `sequence` when every step has
one; otherwise they keep their order in the file.
"""

import asyncio
import json
from collections import OrderedDict
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import Field

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.domain.parse import parse_text
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions
from fiesta.plugins.util import load_visible_contribution, to_float
from fiesta.services.contributions import load_file


class ArgonOptions(PluginOptions):
    """Which search levels get which thumbnail."""

    experiment_levels: list[str] = Field(
        default=["Experiments"],
        description="Search levels whose result items show the experiment's age spectrum",
    )
    specimen_levels: list[str] = Field(
        default=["Specimens"],
        description=(
            "Search levels whose result items show the specimen's experiments' spectra "
            "under its preferred age"
        ),
    )


# The ³⁹Ar release of a step, in order of preference. The first column that
# every step fills sizes the steps; legacy imports fill fraction_39ar_k with
# values that do not sum to 100, so the corrected amount comes first.
AR39_COLUMNS = (
    "corrected_39ar_potassium",
    "fraction_39ar_k",
    "relative_abundance_39ar",
    "intercept_39ar",
)

# Isochron coordinates per step: x, y and their error correlation.
ISOCHRON_COLUMNS = {
    "normal": (
        "corrected_39ar_k_36ar_atm_ratio",
        "corrected_40ar_rad_atm_36ar_atm_ratio",
        "corr_coefficient_40_36_over_39_36",
    ),
    "inverse": (
        "corrected_39ar_k_40ar_rad_atm_ratio",
        "corrected_36ar_atm_40ar_rad_atm_ratio",
        "corr_coefficient_36_40_over_39_40",
    ),
}

TRUE = {"t", "true", "yes", "y", "1"}
FALSE = {"f", "false", "no", "n", "0"}


def experiment_matches(row_experiment: str | None, requested: str) -> bool:
    """Experiment identifiers can differ between the experiments table and the
    measurements table (e.g. "33922-01" vs "33922"); match either direction on
    a hyphen-delimited prefix."""
    if not row_experiment:
        return False
    if row_experiment == requested:
        return True
    return requested.startswith(f"{row_experiment}-") or row_experiment.startswith(f"{requested}-")


def names(value: Any) -> list[str]:
    """A colon-delimited list column (age_steps, age_experiments)."""
    if not value:
        return []
    return [name.strip() for name in str(value).split(":") if name.strip()]


def is_true(value: Any) -> bool | None:
    text = str(value or "").strip().lower()
    return True if text in TRUE else False if text in FALSE else None


def age_kind(method: str | None) -> str:
    """The plot an age belongs on, from its free-text calculation method
    ("Plateau", "Age Plateau", "Inverse Isochron", "Total Gas Fusion", ...)."""
    text = (method or "").lower()
    if "plateau" in text:
        return "plateau"
    if "isochron" in text:
        return "inverse_isochron" if "inverse" in text else "normal_isochron"
    if "fusion" in text or "total gas" in text or "integrated" in text:
        return "total_fusion"
    return "other"


def _int(value: Any) -> int | None:
    number = to_float(value)
    return int(number) if number is not None else None


def _sigma(row: dict) -> float | None:
    return next(
        (
            v
            for c in ("age_sigma_analytical", "age_sigma_internal", "age_sigma_external")
            if (v := to_float(row.get(c))) is not None
        ),
        None,
    )


def contributed_age(row: dict) -> dict:
    """One experiments row: an age as the contributor calculated it."""
    method = row.get("age_calculation_method")
    return {
        "method": method,
        "kind": age_kind(method),
        "preferred": is_true(row.get("age_is_preferred")),
        "age": to_float(row.get("age")),
        "age_sigma": _sigma(row),
        "age_unit": row.get("age_unit") or None,
        "mswd": to_float(row.get("age_mswd")),
        "n": _int(row.get("age_n")),
        "plateau_width": to_float(row.get("age_plateau_width")),
        "steps": names(row.get("age_steps")),
        "ar40_ar39": to_float(row.get("40ar_39ar_ratio")),
        "ar40_ar39_sigma": to_float(row.get("40ar_39ar_ratio_sigma")),
        "ar40_ar36": to_float(row.get("40ar_36ar_ratio")),
        "ar40_ar36_sigma": to_float(row.get("40ar_36ar_ratio_sigma")),
        "trapped_ar40_ar36": to_float(row.get("40ar_36ar_trapped")),
    }


def _point(row: dict, kind: str) -> list[float | None] | None:
    """[x, σx, y, σy, ρ] on the normal or inverse isochron, or None."""
    x_col, y_col, rho_col = ISOCHRON_COLUMNS[kind]
    x, y = to_float(row.get(x_col)), to_float(row.get(y_col))
    if x is None or y is None:
        return None
    return [
        x,
        to_float(row.get(f"{x_col}_sigma")),
        y,
        to_float(row.get(f"{y_col}_sigma")),
        to_float(row.get(rho_col)),
    ]


def build_steps(rows: list[dict]) -> dict:
    """An experiment's heating steps: the contributed age and isochron ratios
    of each, placed on the cumulative ³⁹Ar axis."""
    # Only identical rows are duplicates: legacy imports reuse a measurement
    # name for different steps.
    seen: set[str] = set()
    unique: list[dict] = []
    for row in rows:
        key = json.dumps(row, sort_keys=True, default=str)
        if key not in seen:
            seen.add(key)
            unique.append(row)
    if unique and all(to_float(row.get("sequence")) is not None for row in unique):
        unique.sort(key=lambda row: to_float(row.get("sequence")) or 0.0)

    source = next(
        (c for c in AR39_COLUMNS if unique and all(to_float(r.get(c)) is not None for r in unique)),
        None,
    )
    amounts = [max(0.0, to_float(r.get(source)) or 0.0) for r in unique] if source else []
    total = sum(amounts)
    if total <= 0:
        source, amounts, total = None, [1.0] * len(unique), float(len(unique) or 1)

    steps: list[dict] = []
    without_age = 0
    cumulative = 0.0
    for row, amount in zip(unique, amounts, strict=True):
        start = cumulative
        cumulative += 100.0 * amount / total
        age = to_float(row.get("age"))
        if age is None:
            without_age += 1
            continue
        steps.append(
            {
                "measurement": row.get("measurement") or None,
                "sequence": _int(row.get("sequence")),
                "temperature": to_float(row.get("temp")),
                "temp_unit": row.get("temp_unit") or None,
                "age": age,
                "age_sigma": to_float(row.get("age_sigma_analytical")),
                "ar39_start": start,
                "ar39_end": cumulative,
                "normal": _point(row, "normal"),
                "inverse": _point(row, "inverse"),
            }
        )
    return {
        "steps": steps,
        "steps_without_age": without_age,
        "ar39_source": source,
        "age_unit": next((r.get("age_unit") for r in unique if r.get("age_unit")), None),
    }


def build_argon(tables: dict[str, list[dict]]) -> dict:
    """Every experiment (its steps and contributed ages) and every specimen
    (its preferred age and the experiments it rests on) of a contribution."""
    measurements: dict[str, list[dict]] = {}
    for row in tables.get("measurements", []):
        measurements.setdefault(str(row.get("experiment") or ""), []).append(row)
    rows_by_experiment: dict[str, list[dict]] = {}
    for row in tables.get("experiments", []):
        if row.get("experiment"):
            rows_by_experiment.setdefault(str(row["experiment"]), []).append(row)

    experiments: list[dict] = []
    claimed: set[str] = set()
    for name, rows in rows_by_experiment.items():
        groups = (
            [name]
            if name in measurements
            else [g for g in measurements if experiment_matches(g, name)]
        )
        claimed.update(groups)
        steps = build_steps([row for group in groups for row in measurements[group]])
        experiments.append(
            {
                "experiment": name,
                "specimen": next((r["specimen"] for r in rows if r.get("specimen")), None),
                **steps,
                "age_unit": next((r["age_unit"] for r in rows if r.get("age_unit")), None)
                or steps["age_unit"],
                "ages": [contributed_age(row) for row in rows],
            }
        )
    # Measurements whose experiment has no experiments row still have a spectrum.
    for name, rows in measurements.items():
        if name and name not in claimed:
            experiments.append(
                {"experiment": name, "specimen": None, **build_steps(rows), "ages": []}
            )

    known = [e["experiment"] for e in experiments]
    specimens: list[dict] = []
    rows_by_specimen: dict[str, list[dict]] = {}
    for row in tables.get("specimens", []):
        if row.get("specimen"):
            rows_by_specimen.setdefault(str(row["specimen"]), []).append(row)
    for name, rows in rows_by_specimen.items():
        # Legacy imports repeat a specimen once per age method; the first row
        # with an age is the preferred one.
        row = next((r for r in rows if to_float(r.get("age")) is not None), rows[0])
        listed = names(row.get("age_experiments"))
        if listed:
            members = [
                e for e in known if any(e == want or experiment_matches(e, want) for want in listed)
            ]
        else:
            members = [e["experiment"] for e in experiments if e["specimen"] == name]
        specimens.append(
            {
                "specimen": name,
                "sample": row.get("sample") or None,
                "material": row.get("material_name") or row.get("material_type") or None,
                "method": row.get("age_calculation_method") or None,
                "age": to_float(row.get("age")),
                "age_sigma": _sigma(row),
                "age_unit": row.get("age_unit") or None,
                "experiments": members,
            }
        )
    return {"experiments": experiments, "specimens": specimens}


# Built data per contribution revision. Concurrent requests for one
# contribution (a page of its result tiles) share one task, so the file is
# downloaded and parsed once.
_CACHE: "OrderedDict[tuple, asyncio.Task]" = OrderedDict()
_CACHE_SIZE = 32


async def _argon(node: NodeConfig, contribution) -> dict:
    key = (
        node.node.slug,
        contribution.id,
        contribution.head_revision,
        contribution.filename,
        contribution.updated_at,
    )
    task = _CACHE.get(key)
    loop = asyncio.get_running_loop()
    if task is None or task.get_loop() is not loop or (task.done() and task.exception()):

        async def build() -> dict:
            raw = await load_file(node, contribution.id, contribution.filename)
            parsed = parse_text(raw.decode("utf-8", errors="replace"))
            return build_argon(parsed.tables)

        task = _CACHE[key] = loop.create_task(build())
        while len(_CACHE) > _CACHE_SIZE:
            _CACHE.popitem(last=False)
    _CACHE.move_to_end(key)
    return await asyncio.shield(task)


class PlateauPlugin(FiestaPlugin):
    name = "plateau-calculations"
    description = (
        "⁴⁰Ar/³⁹Ar age spectra, isochrons and specimen ages drawn from the contributed "
        "step ages, plateau and isochron results, on experiment and specimen result items."
    )
    Options = ArgonOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, ArgonOptions)
        levels = {lvl.name for lvl in node.search.levels}
        unknown = [
            lvl
            for lvl in (*options.experiment_levels, *options.specimen_levels)
            if lvl not in levels
        ]
        if unknown:
            raise ValueError(
                f"plugin 'plateau-calculations': levels {unknown} are not search levels"
            )

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/contributions/{contribution_id}")
        async def get_argon(
            session: SessionDep,
            node: NodeDep,
            contribution_id: int,
            private_key: str | None = None,
            experiment: str | None = None,
            specimen: str | None = None,
        ) -> dict:
            """A contribution's experiments (steps, isochron points and every
            contributed age) and specimens (preferred age and its experiments).
            `experiment` narrows it to that experiment, and `specimen` to that
            specimen and its experiments. Both are query parameters because
            the names can contain "/"."""
            contribution = await load_visible_contribution(
                session, node, contribution_id, private_key
            )
            data = await _argon(node, contribution)
            if specimen is not None:
                found = [s for s in data["specimens"] if s["specimen"] == specimen]
                if not found:
                    raise HTTPException(404, f"no specimen {specimen!r} in {contribution_id}")
                members = set(found[0]["experiments"])
                return {
                    "specimens": found,
                    "experiments": [e for e in data["experiments"] if e["experiment"] in members],
                }
            if experiment is not None:
                found = [e for e in data["experiments"] if e["experiment"] == experiment] or [
                    e
                    for e in data["experiments"]
                    if experiment_matches(e["experiment"], experiment)
                ]
                if not found:
                    raise HTTPException(404, f"no experiment {experiment!r} in {contribution_id}")
                return {"experiments": found[:1], "specimens": []}
            return data

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        options = self.options(node)
        assert isinstance(options, ArgonOptions)
        return {
            "view": "age-spectrum",
            "experiment_levels": options.experiment_levels,
            "specimen_levels": options.specimen_levels,
        }
