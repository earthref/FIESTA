"""CDR: depth plots — plot-ready measurement-vs-depth series for cores.

Faithful port of the legacy CDR "Cores Plots" view: measurements are grouped
by core, sorted by depth, and rendered as multi-track plots (shared depth Y
axis, one panel per series). The backend serves the flattened rows; the SVG
rendering lives in the frontend plugin component. Which series are plotted,
which columns give the depth and which search levels get the Plots tab are
the plugin's options in the node YAML.
"""

from fastapi import APIRouter
from pydantic import BaseModel, Field

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions
from fiesta.plugins.util import load_visible_parsed, to_float


class Series(BaseModel):
    """One plotted track: a measurement column, its axis label and color."""

    key: str
    label: str
    color: str = "#1f77b4"


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


class DepthPlotOptions(PluginOptions):
    levels: list[str] = Field(
        default=["Cores"], description="Search levels that get the Plots sub-tab"
    )
    series: list[Series] = Field(
        default=LEGACY_SERIES, description="Measurement columns plotted against depth, in order"
    )
    depth_columns: list[str] = Field(
        default=["mbs_corrected", "depth"],
        description="Measurement columns tried in order for a row's depth",
    )


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
        wanted = [*(s.key for s in options.series), *options.depth_columns]
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
            # CDR measurement rows reference their section; the sections table
            # maps sections to cores.
            section_core = {
                s.get("section"): s.get("core", "")
                for s in parsed.tables.get("sections", [])
                if s.get("section")
            }
            cores: dict[str, list[dict]] = {}
            for row in parsed.tables.get("measurements", []):
                depth = next(
                    (d for c in options.depth_columns if (d := to_float(row.get(c))) is not None),
                    None,
                )
                if depth is None:
                    continue
                section = row.get("section", "")
                flat: dict = {
                    "core": row.get("core") or section_core.get(section, "") or section,
                    "section": section,
                    "depth": depth,
                }
                has_series = False
                for series in options.series:
                    value = to_float(row.get(series.key))
                    if value is not None:
                        flat[series.key] = value
                        has_series = True
                if has_series:
                    cores.setdefault(flat["core"], []).append(flat)
            for rows in cores.values():
                rows.sort(key=lambda r: r["depth"])
            return {"series_defs": [s.model_dump() for s in options.series], "cores": cores}

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        options = self.options(node)
        assert isinstance(options, DepthPlotOptions)
        return {
            "view": "depth-plot",
            # The plot view attaches to these search levels as an extra sub-tab.
            "levels": options.levels,
            "series_defs": [s.model_dump() for s in options.series],
            "depth_columns": options.depth_columns,
        }
