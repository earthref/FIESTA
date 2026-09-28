"""MagIC: rock magnetism — derived, filterable rock-magnetic parameters.

Every rock-magnetic result of a specimen (its rows with hysteresis, remanence,
susceptibility, critical temperature or anisotropy data, complementary rows
together; see `results`) becomes a `rock_mag` search doc whose
`summary.rock_mag` block holds numeric copies of the parameters rock
magnetists plot and filter on, in consistent units (fields in mT, temperatures
in °C) and with the ratios and anisotropy shape parameters derived when the
row only has their parts. The frontend surfaces `rock_mag` as a sub-tab of the
Specimens level (Day plot, squareness–coercivity, Jelinek, stereonet and
distributions) and reads the numbers through GET /search/rock_mag/values.

Many legacy contributions recorded coercivities and MDFs in mT where the data
model says tesla; a field column whose median over the contribution is above
1 T is read as mT (see field_units).

A specimen takes its position and its facet values (lithologies, geologic
classes, ...) from its sample, or the sample's site, when it has none of its
own, so the sidebar's facets and geospatial filter narrow it like the other
levels.
"""

import math
from typing import Any

from pydantic import Field

from fiesta.domain.parse import ParsedContribution
from fiesta.domain.summarize import FACETABLE_COLUMNS, _geo_point, group_rows, merge_rows
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions
from fiesta.plugins.util import to_float

# summary.rock_mag fields (all numbers) and what they are, for the API docs and
# the admin UI. Fields are in mT and temperatures in °C.
FIELDS = {
    "mr_ms": "Mr/Ms, saturation remanence over saturation magnetization",
    "bcr_bc": "Bcr/Bc, remanent coercivity over coercivity",
    "bc": "Bc, coercivity (mT)",
    "bcr": "Bcr, remanent coercivity (mT)",
    "ms": "Ms, mass-normalized saturation magnetization (Am²/kg)",
    "mr": "Mr, mass-normalized saturation remanence (Am²/kg)",
    "chi_mass": "χ, mass-normalized susceptibility (m³/kg)",
    "chi_volume": "κ, volume susceptibility (SI)",
    "chi_fd": "χfd, frequency dependence of susceptibility",
    "tc": "Critical temperature (°C)",
    "s_ratio": "S-ratio",
    "mdf": "Median destructive field (mT)",
    "p": "P, degree of anisotropy (k1/k3)",
    "pj": "P′, corrected degree of anisotropy (Jelinek 1981)",
    "t": "T, shape parameter (Jelinek 1981)",
    "l": "L, lineation (k1/k2)",
    "f": "F, foliation (k2/k3)",
    "v1_dec": "Declination of the maximum anisotropy axis",
    "v1_inc": "Inclination of the maximum anisotropy axis",
    "v3_dec": "Declination of the minimum anisotropy axis",
    "v3_inc": "Inclination of the minimum anisotropy axis",
}

KELVIN = 273.15


class RockMagOptions(PluginOptions):
    base_level: str = Field(
        default="Specimens",
        description="Search level the Rock Magnetism view attaches to as a sub-tab",
    )
    source_table: str = Field(
        default="specimens",
        description="Data-model table whose rows carry the rock-magnetic parameters",
    )


def _num(row: dict, *columns: str) -> float | None:
    """The first of `columns` holding a finite number."""
    for column in columns:
        value = to_float(row.get(column))
        if value is not None and math.isfinite(value):
            return value
    return None


def _positive(value: float | None) -> float | None:
    return value if value is not None and value > 0 else None


def _ratio(top: float | None, bottom: float | None) -> float | None:
    return top / bottom if top is not None and bottom else None


def _eigenvector(row: dict, column: str) -> tuple[float, float, float] | None:
    """(tau, dec, inc) from an `aniso_v1`-style "tau:dec:inc:..." value."""
    parts = str(row.get(column) or "").split(":")
    if len(parts) < 3:
        return None
    values = [to_float(p) for p in parts[:3]]
    if any(v is None or not math.isfinite(v) for v in values):
        return None
    return values[0], values[1], values[2]  # type: ignore[return-value]


def symmetric_eigenvalues(s: list[float]) -> list[float] | None:
    """Eigenvalues, largest first, of the symmetric tensor MagIC stores as
    `aniso_s` (s11, s22, s33, s12, s23, s13), by Jacobi rotations."""
    if len(s) != 6:
        return None
    a = [[s[0], s[3], s[5]], [s[3], s[1], s[4]], [s[5], s[4], s[2]]]
    for _ in range(50):
        p, q = max(((0, 1), (0, 2), (1, 2)), key=lambda pq: abs(a[pq[0]][pq[1]]))
        if abs(a[p][q]) < 1e-15:
            break
        theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        t = math.copysign(1, theta) / (abs(theta) + math.sqrt(theta * theta + 1))
        c = 1 / math.sqrt(t * t + 1)
        sn = t * c
        for k in range(3):
            akp, akq = a[k][p], a[k][q]
            a[k][p], a[k][q] = c * akp - sn * akq, sn * akp + c * akq
        for k in range(3):
            apk, aqk = a[p][k], a[q][k]
            a[p][k], a[q][k] = c * apk - sn * aqk, sn * apk + c * aqk
    return sorted((a[i][i] for i in range(3)), reverse=True)


def anisotropy_shape(k1: float, k2: float, k3: float) -> dict[str, float]:
    """P, P′, T, L and F of eigenvalues k1 ≥ k2 ≥ k3 > 0 (Jelinek 1981)."""
    n1, n2, n3 = math.log(k1), math.log(k2), math.log(k3)
    mean = (n1 + n2 + n3) / 3
    shape = {
        "p": k1 / k3,
        "pj": math.exp(math.sqrt(2 * ((n1 - mean) ** 2 + (n2 - mean) ** 2 + (n3 - mean) ** 2))),
        "l": k1 / k2,
        "f": k2 / k3,
    }
    if n1 > n3:
        shape["t"] = (2 * n2 - n1 - n3) / (n1 - n3)
    return shape


# Columns of fields, in tesla in the data model.
FIELD_COLUMNS = ("hyst_bc", "hyst_bcr", "rem_bcr", "rem_mdf")
# No natural collection has a median coercivity or MDF this high (in tesla):
# a contribution whose column's median is above it recorded that column in mT.
MAX_MEDIAN_TESLA = 1.0


def field_units(rows: list[dict]) -> dict[str, float]:
    """mT per stored unit of each field column in a contribution's rows: 1000
    when it is in tesla, as the data model says, and 1 when its median shows
    it was recorded in mT (common in legacy MagIC data)."""
    units = {}
    for column in FIELD_COLUMNS:
        values = sorted(v for r in rows if (v := _positive(_num(r, column))) is not None)
        median = values[len(values) // 2] if values else 0
        units[column] = 1.0 if median > MAX_MEDIAN_TESLA else 1000.0
    return units


def _field(row: dict, units: dict[str, float], *columns: str) -> float | None:
    """A field in mT from the first of `columns` holding a positive number."""
    for column in columns:
        if (value := _positive(_num(row, column))) is not None:
            return value * units.get(column, 1000.0)
    return None


def rock_mag_values(row: dict, units: dict[str, float] | None = None) -> dict[str, Any]:
    """summary.rock_mag for one specimens row: every parameter it has, or can
    be derived from its columns, that is physically meaningful. `units` are
    the contribution's field_units (tesla by default)."""
    units = units or {}
    values: dict[str, Any] = {}

    # Hysteresis: the ratio as given, else from moments in one normalization.
    mr_ms = _num(row, "hyst_mr_ms")
    if mr_ms is None:
        for norm in ("mass", "volume", "moment"):
            mr = _num(row, f"hyst_mr_{norm}", f"rem_mr_{norm}")
            mr_ms = _ratio(mr, _positive(_num(row, f"hyst_ms_{norm}")))
            if mr_ms is not None:
                break
    if mr_ms is not None and 0 < mr_ms <= 1:
        values["mr_ms"] = mr_ms
    bc = _field(row, units, "hyst_bc")
    bcr = _field(row, units, "hyst_bcr", "rem_bcr")
    if bc is not None:
        values["bc"] = bc
    if bcr is not None:
        values["bcr"] = bcr
    bcr_bc = _positive(_num(row, "hyst_bcr_bc")) or _ratio(bcr, bc)
    if bcr_bc is not None:
        values["bcr_bc"] = bcr_bc
    for key, column in (("ms", "hyst_ms_mass"), ("mr", "hyst_mr_mass")):
        if (value := _positive(_num(row, column))) is not None:
            values[key] = value

    # Susceptibility and remanence.
    for key, column in (
        ("chi_mass", "susc_chi_mass"),
        ("chi_volume", "susc_chi_volume"),
        ("chi_fd", "susc_f"),
        ("s_ratio", "rem_sratio"),
    ):
        if (value := _num(row, column)) is not None:
            values[key] = value
    if (mdf := _field(row, units, "rem_mdf")) is not None:
        values["mdf"] = mdf

    # Critical temperature (K in the data model), or the middle of its range.
    temp = _num(row, "critical_temp")
    if temp is None:
        low, high = _num(row, "critical_temp_low"), _num(row, "critical_temp_high")
        if low is not None and high is not None:
            temp = (low + high) / 2
    if temp is not None and 0 < temp < 2000:
        values["tc"] = temp - KELVIN

    # Anisotropy: eigenvalues from the eigenparameters, else the tensor; the
    # axes only from the eigenparameters (the tensor may be in specimen
    # coordinates).
    axes = [_eigenvector(row, f"aniso_v{i}") for i in (1, 2, 3)]
    if all(axes):
        eigenvalues = sorted((axis[0] for axis in axes), reverse=True)  # type: ignore[index]
    else:
        tensor = [to_float(v) for v in str(row.get("aniso_s") or "").split(":")]
        eigenvalues = (
            symmetric_eigenvalues(tensor)  # type: ignore[arg-type]
            if len(tensor) == 6 and all(v is not None and math.isfinite(v) for v in tensor)
            else None
        )
    if eigenvalues and eigenvalues[2] > 0:
        values.update(anisotropy_shape(*eigenvalues))
    else:
        for key, column in (("p", "aniso_p"), ("t", "aniso_t")):
            if (value := _num(row, column)) is not None:
                values[key] = value
    # Axes in specimen coordinates (tilt correction -1) aren't directions in
    # the world: only geographic (0) and tilt-corrected (100) ones are kept.
    in_world = _num(row, "aniso_tilt_correction") != -1
    for key, axis in (("v1", axes[0]), ("v3", axes[2])):
        if in_world and axis and -90 <= axis[2] <= 90:
            values[f"{key}_dec"] = axis[1] % 360
            values[f"{key}_inc"] = axis[2]

    # JSON numbers with a fraction, so OpenSearch maps each field as a float.
    return {key: float(value) for key, value in values.items()}


def results(
    specimens: list[list[dict]], units: dict[str, float]
) -> list[tuple[dict[str, float], list[dict]]]:
    """A specimen's rows as rock-magnetic results: rows with complementary
    parameters (a hysteresis row, an anisotropy row, a Curie temperature row)
    are one result, one point on every plot; a row repeating parameters
    another already gave (hysteresis at another temperature) starts a
    result of its own. Rows with none are left out."""
    found: list[tuple[dict[str, float], list[dict]]] = []
    for group in specimens:
        own: list[tuple[dict[str, float], list[dict]]] = []
        for row in group:
            values = rock_mag_values(row, units)
            if not values:
                continue
            into = next((r for r in own if not r[0].keys() & values.keys()), None)
            if into is None:
                own.append((values, [row]))
            else:
                into[0].update(values)
                into[1].append(row)
        found += own
    return found


class RockMagPlugin(FiestaPlugin):
    name = "rock-mag"
    description = (
        "Derives a searchable `rock_mag` document with numeric hysteresis, "
        "susceptibility, critical temperature and anisotropy parameters from every "
        "specimen that has them, and shows them as a Rock Magnetism sub-tab of plots."
    )
    Options = RockMagOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, RockMagOptions)
        levels = {lvl.name for lvl in node.search.levels}
        if options.base_level not in levels:
            raise ValueError(
                f"plugin 'rock-mag': base_level {options.base_level!r} is not a search level"
            )
        tables = node.load_data_model(node.data_model.latest)["tables"]
        if options.source_table not in tables:
            raise ValueError(
                f"plugin 'rock-mag': source_table {options.source_table!r} "
                "is not a data-model table"
            )

    def search_tables(self, node: NodeConfig) -> list[str]:
        return ["rock_mag"]

    def derive_docs(
        self, node: NodeConfig, parsed: ParsedContribution, contribution_meta: dict
    ) -> list[dict]:
        source = self.options(node).source_table
        sites = {str(r.get("site")): r for r in parsed.tables.get("sites", []) if r.get("site")}
        samples = {
            str(r.get("sample")): r for r in parsed.tables.get("samples", []) if r.get("sample")
        }
        docs: list[dict] = []
        rows = parsed.tables.get(source, [])
        units = field_units(rows)
        for values, group in results(group_rows(rows, source.removesuffix("s")), units):
            row = merge_rows(group)
            sample = samples.get(str(row.get("sample") or ""), {})
            site = sites.get(str(row.get("site") or sample.get("site") or ""), {})
            lineage = [row, sample, site]
            all_block: dict[str, Any] = {}
            for column in FACETABLE_COLUMNS:
                value = next((r[column] for r in lineage if r.get(column)), None)
                if value:
                    all_block[column] = [v.strip() for v in str(value).split(":") if v.strip()]
            geo = next((g for r in lineage if r and (g := _geo_point(r))), None)
            if geo is not None:
                all_block["_geo_point"] = geo
            docs.append(
                {
                    "type": "rock_mag",
                    "summary": {
                        "contribution": contribution_meta,
                        source: {**row, "_n_results": len(group)},
                        "rock_mag": values,
                        "_all": all_block,
                    },
                    "rows": group,
                }
            )
        return docs

    def frontend_config(self, node: NodeConfig) -> dict:
        # The range filters on the view are `search.filters` entries in the
        # node YAML on summary.rock_mag.<field> (see FIELDS).
        return {"view": "rock-mag", "table": "rock_mag", **self.options(node).model_dump()}
