# `depth-plot` (CDR)

`GET /v2/{node}/plugins/depth-plot/contributions/{id}/measurements` returns
depth-sorted measurement rows grouped by core (depth = the first of
`depth_columns` present), every Number `measurements` column with data as a
track (the YAML `series` first and on by default, the rest in data-model
order with the model's label, unit and group), the `ratios` whose two columns
have data, and each core's section spans taken from its rows' depths (the
sections table's depths are cm in mixed frames). Rows in `exclude_sections`
or shallower than `min_depth` (calibration runs) are left out; rows whose
`quality_column` is in `bad_quality` carry `_bad: true`.

UI: multi-track SVG depth plots as a "Plots" sub-tab on the `levels` option's
levels, the contribution modal's Depth Plots tab, and the summary grid's
`plot` tile (legacy CDR's depth thumbnail; a core's card draws that core) on
the levels where the node YAML places one. The Plots sub-tab is a `records`
tab: it counts the level's matches (filtered as on Summaries), draws only the
matched cores, and has one controls bar at the top, over the union of every
plotted contribution's tracks, that drives all of its plots. The full plot has:

- every track as a toggle **chip** above the plots, by group (MST / XRF /
  Ratios; Defaults, All, None);
- plots **reordered** by dragging a header onto another (or the left and
  right arrow keys on its grip) and **recolored** from its swatch; picks,
  order, colors and log scales are kept per node in the browser
  (`localStorage` `fiesta:depth-plot:<slug>`);
- text no smaller than 11px (the modal's count pills) and 800px plots;
- **flagged points** hidden by default, drawn as red dots on request;
- value axes scaled to the **2nd–98th percentile** so spikes do not flatten a
  track, a per-track **log** toggle (`log: true` on a series starts it there),
  and far off-scale values (a failed scan's zeros) shown as edge ticks that
  break the line;
- value ticks and gridlines, dashed **section boundaries** named in the right
  margin, and line breaks at section ends and depth gaps;
- a **hover readout** across tracks and **drag-to-zoom** on depth
  (double-click or Reset zoom to go back).

Options: `levels`, `series` (`key`, `label`, `color`, `log`), `ratios`
(`numerator`, `denominator`, `log` for ln, `label`, `color`, `default`),
`depth_columns`, `quality_column`, `bad_quality`, `exclude_sections`,
`min_depth`.

| File | What |
|---|---|
| `plugin.py` | `DepthPlotPlugin`: options, `plot_payload` and the measurements route |
| `index.tsx` | the UI module: modal tab, Plots sub-tab, grid thumbnail |
| `depth-plot-view.tsx` | the interactive plot: controls, tracks, hover, zoom |
| `depth-plot-data.ts` | payload parsing, track values, scales, ticks, gap/off-scale splitting |
| `test_depth_plot.py` | the payload and option checks against CDR's YAML and model |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
