"""CDR: depth plots — plot-ready measurement-vs-depth series for cores.

Started as a port of the legacy CDR "Cores Plots" view: measurements are
grouped by core, sorted by depth, and rendered as multi-track plots (shared
depth Y axis, one panel per series). The backend serves the flattened rows,
every numeric measurement column with data as a pickable track, the
configured element ratios and each core's section intervals; the SVG
rendering lives in the frontend plugin component. Which series are plotted by
default, which columns give the depth, which rows are calibration or flagged
bad, and which search levels get the Plots tab are the plugin's options in
the node YAML.
"""

import math

from fastapi import APIRouter
from pydantic import BaseModel, Field

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions
from fiesta.plugins.util import load_visible_parsed, to_float


class Series(BaseModel):
    """One default track: a measurement column, its axis label and color."""

    key: str
    label: str
    color: str = "#1f77b4"
    log: bool = Field(default=False, description="Start the track on a log scale")


class Ratio(BaseModel):
    """A derived track, numerator / denominator (ln of it when `log`)."""

    numerator: str
    denominator: str
    log: bool = Field(default=False, description="Plot ln(numerator / denominator)")
    label: str | None = None
    color: str = "#444444"
    default: bool = Field(default=False, description="Shown without being picked")

    @property
    def key(self) -> str:
        return f"{'ln_' if self.log else ''}{self.numerator}_{self.denominator}"

    def dump(self) -> dict:
        ratio = f"{self.numerator.capitalize()}/{self.denominator.capitalize()}"
        label = self.label or (f"ln({ratio})" if self.log else ratio)
        return {**self.model_dump(), "key": self.key, "label": label}


# The legacy seriesDefs; the default for a node that sets nothing.
LEGACY_SERIES = [
    Series(key="gamma_density", label="Gamma Density", color="#1f77b4"),
    Series(key="mag_susc_chi_mass", label="Mag Susc χmass", color="#ff7f0e"),
    Series(key="res", label="Resistivity (ohm-m)", color="#2ca02c"),
    Series(key="pwave_v", label="P-wave Velocity (m/s)", color="#d62728"),
    Series(key="fp", label="Porosity (frac)", color="#9467bd"),
    Series(key="k", label="K (cps)", color="#8c564b"),
    Series(key="ca", label="Ca (cps)", color="#e377c2"),
    Series(key="ti", label="Ti (cps)", color="#7f7f7f"),
    Series(key="fe", label="Fe (cps)", color="#bcbd22"),
    Series(key="zr", label="Zr (cps)", color="#17becf"),
]

# Colors for the tracks the YAML does not list, in data-model order.
TRACK_PALETTE = [
    "#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948",
    "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac", "#1b9e77", "#d95f02",
    "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d", "#666666",
]  # fmt: skip


class DepthPlotOptions(PluginOptions):
    levels: list[str] = Field(
        default=["Cores"], description="Search levels that get the Plots sub-tab"
    )
    series: list[Series] = Field(
        default=LEGACY_SERIES,
        description="Tracks shown by default, in order; every other numeric "
        "measurements column with data can be picked in the plot",
    )
    ratios: list[Ratio] = Field(
        default=[], description="Derived ratio tracks offered when both columns have data"
    )
    depth_columns: list[str] = Field(
        default=["mbs_corrected", "depth"],
        description="Measurement columns tried in order for a row's depth",
    )
    quality_column: str | None = Field(
        default="quality", description="Measurement column flagging a row's quality"
    )
    bad_quality: list[str] = Field(
        default=["b"],
        description="Values of quality_column that mark a row bad (hidden by default)",
    )
    exclude_sections: list[str] = Field(
        default=["cal"], description="Sections left out of the plots (calibration runs)"
    )
    min_depth: float | None = Field(
        default=0.0, description="Rows shallower than this depth are left out (None keeps all)"
    )


def numeric_columns(node: NodeConfig) -> dict[str, dict]:
    """The latest data model's Number measurement columns, in model order."""
    columns = (
        node.load_data_model(node.data_model.latest)["tables"]
        .get("measurements", {})
        .get("columns", {})
    )
    ordered = sorted(columns.items(), key=lambda item: item[1].get("position", 0))
    return {key: column for key, column in ordered if column.get("type") == "Number"}


def _finite(value) -> float | None:
    number = to_float(value)
    return number if number is not None and math.isfinite(number) else None


def plot_payload(
    options: DepthPlotOptions, columns: dict[str, dict], tables: dict[str, list[dict]]
) -> dict:
    """Depth-sorted rows per core, the tracks and ratios they can draw, and
    each core's section intervals (from the rows: the sections table's depths
    are cm in mixed frames)."""
    # CDR measurement rows reference their section; the sections table maps
    # sections to cores.
    section_core = {
        s.get("section"): s.get("core", "") for s in tables.get("sections", []) if s.get("section")
    }
    track_keys = [c for c in columns if c not in options.depth_columns]
    excluded = set(options.exclude_sections)
    bad = set(options.bad_quality)
    present: set[str] = set()
    cores: dict[str, list[dict]] = {}
    for row in tables.get("measurements", []):
        section = row.get("section", "")
        if section in excluded:
            continue
        depth = next(
            (d for c in options.depth_columns if (d := _finite(row.get(c))) is not None), None
        )
        if depth is None or (options.min_depth is not None and depth < options.min_depth):
            continue
        flat: dict = {}
        for key in track_keys:
            if (value := _finite(row.get(key))) is not None:
                flat[key] = value
        if not flat:
            continue
        present.update(flat)
        flat["depth"] = depth
        flat["section"] = section
        if options.quality_column and row.get(options.quality_column) in bad:
            flat["_bad"] = True
        core = row.get("core") or section_core.get(section, "") or section
        cores.setdefault(core, []).append(flat)

    sections: dict[str, list[dict]] = {}
    for core, rows in cores.items():
        rows.sort(key=lambda r: r["depth"])
        spans: dict[str, dict] = {}
        for r in rows:
            span = spans.setdefault(r["section"], {"section": r["section"], "top": r["depth"]})
            span["bottom"] = r["depth"]
        sections[core] = sorted(spans.values(), key=lambda s: s["top"])

    series = {s.key: s for s in options.series}
    tracks = []
    for key in [*series, *(k for k in track_keys if k not in series)]:
        if key not in present:
            continue
        column = columns.get(key, {})
        unit = column.get("unit")
        if key in series:
            label, color, log = series[key].label, series[key].color, series[key].log
        else:
            label = column.get("label") or key
            if unit:
                label = f"{label} ({unit})"
            color, log = TRACK_PALETTE[len(tracks) % len(TRACK_PALETTE)], False
        tracks.append(
            {
                "key": key,
                "label": label,
                "unit": unit,
                "group": column.get("group") or "Other",
                "color": color,
                "log": log,
                "default": key in series,
            }
        )
    ratios = [
        r.dump() for r in options.ratios if r.numerator in present and r.denominator in present
    ]
    return {
        "series_defs": [s.model_dump() for s in options.series],
        "tracks": tracks,
        "ratios": ratios,
        "cores": cores,
        "sections": sections,
    }


class DepthPlotPlugin(FiestaPlugin):
    name = "depth-plot"
    description = (
        "Measurement-versus-depth plots per core, as a Plots sub-tab of the "
        "configured search levels."
    )
    Options = DepthPlotOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, DepthPlotOptions)
        levels = {lvl.name for lvl in node.search.levels}
        if unknown := [lvl for lvl in options.levels if lvl not in levels]:
            raise ValueError(f"plugin 'depth-plot': levels {unknown} are not search levels")
        columns = (
            node.load_data_model(node.data_model.latest)["tables"]
            .get("measurements", {})
            .get("columns", {})
        )
        wanted = [
            *(s.key for s in options.series),
            *options.depth_columns,
            *(c for r in options.ratios for c in (r.numerator, r.denominator)),
            *([options.quality_column] if options.quality_column else []),
        ]
        if unknown := [c for c in wanted if c not in columns]:
            raise ValueError(f"plugin 'depth-plot': {unknown} are not measurements columns")

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/contributions/{contribution_id}/measurements")
        async def get_measurements(
            session: SessionDep,
            node: NodeDep,
            contribution_id: int,
            private_key: str | None = None,
        ) -> dict:
            """Flattened measurement rows for depth plotting, grouped by core."""
            options = self.options(node)
            assert isinstance(options, DepthPlotOptions)
            _, parsed = await load_visible_parsed(session, node, contribution_id, private_key)
            return plot_payload(options, numeric_columns(node), parsed.tables)

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        options = self.options(node)
        assert isinstance(options, DepthPlotOptions)
        return {
            "view": "depth-plot",
            # The plot view attaches to these search levels as an extra sub-tab.
            "levels": options.levels,
            "series_defs": [s.model_dump() for s in options.series],
            "ratios": [r.dump() for r in options.ratios],
            "depth_columns": options.depth_columns,
        }
