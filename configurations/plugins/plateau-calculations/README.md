# `plateau-calculations` (KArAr)

⁴⁰Ar/³⁹Ar age spectra, isochrons and specimen ages drawn from the
contributed values. Nothing is recalculated or refitted. The legacy
`PlateauCalculations` class recomputed step ages with an assumed J and chose
its own plateau; this plugin replaced that on 2026-11-12, and
[docs/legacy-ux-spec.md](../../../docs/legacy-ux-spec.md) ("KArAr age plots")
records the deviation. The plugin keeps its name so that node configurations
need no change.

| Plot | Drawn from |
|---|---|
| Age spectrum | `measurements.age` ± `age_sigma_analytical` per step. The steps are sized by the first of `corrected_39ar_potassium`, `fraction_39ar_k`, `relative_abundance_39ar` and `intercept_39ar` that every step fills, normalised to 100%, and drawn with equal widths when none is filled. The plateau is the experiment's Plateau row: its `age_steps` are highlighted, and its age ± σ, MSWD and `age_plateau_width` are shown. |
| Inverse and normal isochrons | The steps' `corrected_39ar_k_40ar_rad_atm_ratio` / `corrected_36ar_atm_40ar_rad_atm_ratio` (inverse) and `corrected_39ar_k_36ar_atm_ratio` / `corrected_40ar_rad_atm_36ar_atm_ratio` (normal), drawn as 1σ ellipses using the `corr_coefficient_*` correlations. The line runs through the isochron row's `40ar_39ar_ratio` and `40ar_36ar_ratio` intercepts. Steps missing from that row's `age_steps` are drawn hollow. |
| Specimen view | The spectra of the specimen's `age_experiments` (or, when that is empty, of the experiments whose `specimen` names it), one hue each, under the specimen's preferred age ± σ. |

An experiment's rows (one per `age_calculation_method`) are sorted onto the
plots by their method's text: anything containing "plateau", "isochron" (with
or without "inverse"), or "fusion" / "total gas". When a row lists no
intercepts, no ratios or no steps, the caption says so. Measurements are
matched to experiments exactly, or else on a hyphen-delimited prefix
("33922" ↔ "33922-01").

`GET /v2/{node}/plugins/plateau-calculations/contributions/{id}` returns
`{experiments, specimens}`. `?experiment=` or `?specimen=` narrows the result,
as the tiles do. The built data is cached per contribution revision, and
concurrent requests share a single download and parse.

UI: two contribution-modal asset tabs, laid out as MagIC's plot tabs are
(`fiesta/frontend/src/components/plot-grid.tsx`, shared with `pmag-plots`):
the selected plot drawn large, and every plot as a small card to pick from,
below it or in a column beside it, with a name filter.

- **Specimen Age Plots** (`specimen-age-plots`, counted by the first
  `specimen_levels` level): a specimen's experiments' spectra under its
  preferred age, with a legend and links to each experiment's plots.
- **Experiment Age Plots** (`experiment-age-plots`, counted by the first
  `experiment_levels` level): an experiment's spectrum and isochrons with their
  captions, and every age contributed for it. The cards follow the specimens'
  order, then the experiments no specimen lists.

An experiment's spectrum is the `plot` tile of the levels in
`experiment_levels`, and the specimen view is the tile of the levels in
`specimen_levels`. A tile opens its tab with that item selected
(`?plot=<name>`).

Options (set in karar.yaml): `experiment_levels` and `specimen_levels`.

| File | What |
|---|---|
| `plugin.py` | `PlateauPlugin`: options, building the data from the parsed tables, the route |
| `argon-data.ts` | Response types, the query hook, age helpers |
| `argon-plots.tsx` | SVG age spectrum, isochrons and the specimen overlay |
| `argon-view.tsx` | The two modal tabs: the selected plot, its captions and ages table, the cards |
| `index.tsx` | The grid tiles and the tab registration |
| `test_plateau_calculations.py` | Contributed ages, ³⁹Ar sizing, isochron points, experiment and specimen linking |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
