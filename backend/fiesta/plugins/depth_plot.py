"""CDR: depth plots — plot-ready measurement-vs-depth series for cores.

Faithful port of the legacy CDR "Cores Plots" view: measurements are grouped
by core, sorted by depth, and rendered as multi-track plots (shared depth Y
axis, one panel per series). The backend serves the flattened rows; the SVG
rendering lives in the frontend plugin component.
"""

from fastapi import APIRouter

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin
from fiesta.plugins.util import load_visible_parsed, to_float

#: Measurement series tracks, matching the legacy seriesDefs (key, label, color).
SERIES_DEFS = [
    {"key": "gamma_density", "label": "Gamma Density", "color": "#1f77b4"},
    {"key": "mag_susc_chi_mass", "label": "Mag Susc χmass", "color": "#ff7f0e"},
    {"key": "res", "label": "Resistivity (ohm-m)", "color": "#2ca02c"},
    {"key": "pwave_v", "label": "P-wave Velocity (m/s)", "color": "#d62728"},
    {"key": "fp", "label": "Porosity (frac)", "color": "#9467bd"},
    {"key": "k", "label": "K (cps)", "color": "#8c564b"},
    {"key": "ca", "label": "Ca (cps)", "color": "#e377c2"},
    {"key": "ti", "label": "Ti (cps)", "color": "#7f7f7f"},
    {"key": "fe", "label": "Fe (cps)", "color": "#bcbd22"},
    {"key": "zr", "label": "Zr (cps)", "color": "#17becf"},
]

DEPTH_COLUMNS = ["mbs_corrected", "depth"]


class DepthPlotPlugin(FiestaPlugin):
    name = "depth-plot"

    def build_router(self, node: NodeConfig) -> APIRouter:
        router = APIRouter()

        @router.get("/contributions/{contribution_id}/measurements")
        async def get_measurements(
            session: SessionDep,
            node: NodeDep,
            contribution_id: int,
            private_key: str | None = None,
        ) -> dict:
            """Flattened measurement rows for depth plotting, grouped by core."""
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
                    (d for c in DEPTH_COLUMNS if (d := to_float(row.get(c))) is not None), None
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
                for series in SERIES_DEFS:
                    value = to_float(row.get(series["key"]))
                    if value is not None:
                        flat[series["key"]] = value
                        has_series = True
                if has_series:
                    cores.setdefault(flat["core"], []).append(flat)
            for rows in cores.values():
                rows.sort(key=lambda r: r["depth"])
            return {"series_defs": SERIES_DEFS, "cores": cores}

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        return {
            "view": "depth-plot",
            # The plot view attaches to these search levels as an extra sub-tab.
            "levels": ["Cores"],
            "series_defs": SERIES_DEFS,
            "depth_columns": DEPTH_COLUMNS,
        }
