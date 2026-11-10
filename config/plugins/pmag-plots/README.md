# `pmag-plots` (MagIC)

The legacy site's cached PmagPy plot images (`make_magic_plots.py`), drawn
interactively instead: one contribution-modal tab per plot type with a count —
Equal Area, Zijderveld, Demagnetization, Arai, Deremagnetization, Hysteresis
(the Pole Map is the `poles` plugin's Poles tab).

The backend groups and pairs the measurements with ports of the pmag.py
functions the plots need rather than a PmagPy dependency
(matplotlib/pandas/scipy): `dir2cart`, `dogeo`, `dotilt`, `fisher_mean` and
sortarai's zero-field/in-field pairing.

- **Demagnetization** steps are a specimen's LT-NO / LT-AF-Z / LT-T-Z / LT-M-Z
  / LT-LT-Z rows (its paleointensity experiment's zero-field steps when it has
  no other), in specimen coordinates and, from the sample's `azimuth`/`dip`
  and `bed_dip_direction`/`bed_dip`, geographic and tilt-corrected ones, with
  the specimens table's fits (DE-BFL lines, DE-BFP planes).
- **Arai** steps are a specimen's LP-PI-TRM measurements, excluding anisotropy
  and cooling-rate steps that reuse LT-T-I: NRM remaining |Z| against pTRM
  gained |I − Z| over the NRM, pTRM checks against the zero-field step before
  them, tail checks, and the published interpretation's slope over its steps
  times its correction factors (on contribution 20557 it reproduces every
  `int_abs` to within 1%).
- **Equal Area** also plots the sites of each location and the samples and
  specimens of each site, with Fisher means.
- A **hysteresis** loop plots in `sequence` order (file order when a row has
  none), after restoring numbers that lost their trailing zeros in a
  spreadsheet (…9009, 901, 9011… — contributions 20340 and 20710); the other
  plots in file order.

`summary.pmag_plots` of one `pmag_plots` doc per contribution holds the counts;
`GET /v2/{node}/plugins/pmag-plots/contributions/{id}/{kind}` (`demag`,
`eqarea`, `arai`, `hyst`) serves the plot data, parsed once per contribution
revision and cached.

UI: a filterable grid of echarts plots with a coordinate-system and level
switch; a plot enlarges with its neighbours a click away, wheel zoom, and step
values on hover.

Options: `plot_types` (the tabs, in order).

| File | What |
|---|---|
| `plugin.py` | `PmagPlotsPlugin`: the pmag.py ports, plot data, counts doc, routes |
| `index.tsx` | the UI module: one contribution modal tab per plot type |
| `pmag-plots-view.tsx`, `pmag-plots-charts.ts`, `pmag-plots-data.ts` | the plot grid, the echarts options, the API types |
| `test_pmag_plots.py` | the ports against PmagPy, plot data, sequence repair, counts |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
