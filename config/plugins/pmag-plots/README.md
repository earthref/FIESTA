# `pmag-plots` (MagIC)

The legacy site's cached PmagPy plot images (`make_magic_plots.py`), drawn
interactively instead: one contribution-modal tab per plot type with a count —
Equal Area, Zijderveld, Demagnetization, Arai, Deremagnetization, Hysteresis
(the Pole Map is the `poles` plugin's Poles tab).

PmagPy (`from pmagpy import pmag`, a backend dependency) does the science, so
the plots match the legacy images, and the API sends ready-to-draw
coordinates: the frontend projects nothing.

| PmagPy | Used for |
|---|---|
| `find_dmag_rec` | a specimen's demagnetization steps: treatment (T, K, J), direction, moment, flag |
| `dogeo_V`, `dotilt_V` | the steps in geographic and tilt-corrected coordinates |
| `dir2cart` | each step's north, east, down components over the NRM (Zijderveld, as `plot_zij` normalizes) and a fit line's ends |
| `fisher_mean` | the mean of each group's lines (α95 180° when too scattered for a cone, as PmagPy reports it) |
| `dimap_V` | every position on the equal-area net, and the net itself (`plot_net`'s rim, ticks and crosses) |
| `circ` | α95 circles and planes' great circles, split into lower (solid) and upper (dashed) runs as `plot_circ` splits them (I < 0 is up) |
| `sortarai(..., version=3)` | the Thellier pairing: NRM remaining against pTRM gained, ZI/IZ from the LP-PI-TRM-IZ code, pTRM checks against the record before them, tail checks as \|tail\| − \|zero-field\| (all placed as `plot_arai` places them) |
| `int_pars`, `dovds` | the York slope b, its σ, f, g, q over the published interpretation's steps (three or more) |

What stays custom, because PmagPy has no function for it:

- **Grouping** by the specimen → sample → site → location hierarchy, and the
  equal-area plots per location and site (PmagPy's scripts plot per file).
- **Row selection.** Demagnetization steps are a specimen's LT-NO / LT-AF-Z /
  LT-T-Z / LT-M-Z rows outside anisotropy, ARM, TRM, IRM, hysteresis and
  cooling-rate experiments (its paleointensity experiment's zero-field steps
  when it has no other), without pTRM checks; Arai steps are its LP-PI-TRM
  rows (as `thellier_magic` selects them), the NRM first.
- **Cleaning legacy rows** PmagPy raises on or misreads: blank treatments,
  directions or moments, NRMs after the first, tail checks with no
  zero-field step, a pTRM check with nothing before it. One bad row loses
  that row, never the plot or the route. AF values over 1 T are read as mT.
- **Hysteresis**: a loop plots in `sequence` order (file order when a row has
  none), after restoring numbers that lost their trailing zeros in a
  spreadsheet (…9009, 901, 9011… — contributions 20340 and 20710).
- **The payload**: compact, rounded columns; the plots are cached per
  contribution revision. PmagPy's data model 3 functions take a DataFrame
  only to call `.to_dict("records")`, so they get a list that answers it
  (pandas per specimen cost more than the science).

**Search grid thumbnails.** The Plot tile of a contribution, location, site,
sample or specimen shows one of its plots with the record's plot count in the
corner (the legacy grid showed one cached PNG and a count); a click opens that
plot's tab of the contribution. A record's plots are those of the specimens
below it and its equal-area groups (a location's sites, a site's samples and
specimens). `_PlotIndex` selects them without PmagPy, and only the records a
thumbnail draws go through it: a random specimen's Zijderveld components
(geographic when oriented), a random group's equal-area positions, a
specimen's Arai steps and a hysteresis loop, each at most 150 points, seeded
by the contribution and record so the same one is drawn again. A type that
fails is left out.

- A contribution's thumbnails are kept by indexing, in
  `summary.pmag_plots._geometry.thumbnails` (stored, never indexed).
- `GET /v2/{node}/plugins/pmag-plots/thumbnails/{id}?table=&name=` serves any
  record's `counts` and `thumbnails`. It also serves a contribution indexed
  before thumbnails existed. Each API process builds the plot index of the last
  4 contributions asked for (0.1–2.5 s for the largest local ones) and keeps the
  last 10,000 answers.

The browser picks one type per record and page load and draws it as SVG
(`pmag-plots-thumbnail.tsx`).

`summary.pmag_plots` of one `pmag_plots` doc per contribution holds the counts
(`compute_counts`: the same row selection, without the PmagPy calls);
`GET /v2/{node}/plugins/pmag-plots/contributions/{id}/{kind}` serves the plot
data. Each API process keeps the last 8 contributions viewed, per revision
(`_Plots`): a kind is computed when a tab first asks for it (requests for it
at the same time share the computation), encoded once as JSON and gzip, and
served gzipped to clients that accept it. Once one kind has been served, the
others are computed in the background, so the rest of a contribution's tabs
open at once. On McMurdo (25.5k measurements) the first tab takes about 2 s,
2.2 MB of JSON sent as 0.6 MB; later tabs and repeat views take under a
millisecond.

- `demag`: `net`, and per specimen its steps (kind, value in mT / °C / J,
  moment, bad flag), `coords.{s,g,t}` (dec, inc, equal-area x/y, north, east,
  down over the NRM) and its fits (with `xy` on the net, a plane's `circle`,
  a line's Zijderveld `zijd` ends);
- `eqarea`: `net`, and per group its directions by coordinate system (each
  with `xy` or a plane's `circle`) and Fisher mean (`xy`, α95 `circle`);
- `arai`: per specimen its steps, pTRM checks, tail checks and the published
  interpretation's fit (`b`, `b_sigma`, `f`, `g`, `q`, `line`, `int_calc`);
- `hyst`: per loop its fields and moments.

UI: a tab per plot type with a coordinate-system and level switch and a name
filter. The selected plot (the first, or `?plot=<key>`) is drawn large and
interactive (wheel and box zoom, step values on hover), and every plot of the
level is a small card to pick from (the selected one's border in the node
color), below it or in a column beside it, whichever leaves the cards the
larger view; the cards scroll virtually. A search grid's Plot tile opens its
contribution's tab with that plot selected (`?plot=`: a specimen's name, or an
equal-area group's `<level>:<name>`, which the thumbnail carries as `level`).

Options: `plot_types` (the tabs, in order).

| File | What |
|---|---|
| `plugin.py` | `PmagPlotsPlugin`: row selection and cleaning, the PmagPy calls, plot data, counts doc, routes |
| `index.tsx` | the UI module: one contribution modal tab per plot type |
| `pmag-plots-view.tsx`, `pmag-plots-charts.ts`, `pmag-plots-data.ts` | the plot grid, the echarts options (drawing only), the API types |
| `test_pmag_plots.py` | the geometry against PmagPy, plot data, malformed rows, sequence repair, counts |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
