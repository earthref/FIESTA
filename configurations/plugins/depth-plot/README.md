# `depth-plot` (CDR)

`GET /v2/{node}/plugins/depth-plot/contributions/{id}/measurements` returns
depth-sorted measurement rows grouped by core (depth = the first of
`depth_columns` present; the `series` tracks, matching the legacy view, are
options in cdr.yaml).

UI: multi-track SVG depth plots as a "Plots" sub-tab on the `levels` option's
levels, the contribution modal's Depth Plots tab, and the summary grid's
`plot` tile (legacy CDR's depth thumbnail; a core's card draws that core) on
the levels where the node YAML places one.

Options: `levels`, `depth_columns`, `series`.

| File | What |
|---|---|
| `plugin.py` | `DepthPlotPlugin`: options and the measurements route |
| `index.tsx` | the UI module and the depth plots |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
