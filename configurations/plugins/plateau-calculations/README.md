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
| Companion spectra (under the age spectrum, same ³⁹Ar axis) | Each step's `k_ca_ratio` ± σ (K/Ca), `fraction_40ar_radiogenic` (⁴⁰Ar\*, in %; an experiment giving every step as a fraction of 1 is multiplied by 100), and `corrected_38ar_chlorine` / `corrected_39ar_potassium` (³⁸Ar(Cl)/³⁹Ar(K), proportional to Cl/K; the lab's production factor is not applied). K/Ca and Cl/K go on a log axis when every value is positive and they span 20× or more. A panel shows only when some step fills it. |
| Release curve | Each step's cumulative ³⁹Ar against its `temp` (in its `temp_unit`), when the steps are sized by a ³⁹Ar column and two or more have a temperature. |
| Specimen view | The spectra of the specimen's `age_experiments` (or, when that is empty, of the experiments whose `specimen` names it), one hue each, under the specimen's preferred age ± σ. |
| Ranked ages and ideogram (specimen) | Each of its experiments' contributed age (the preferred row, else the plateau, else the first with an age) ± σ, youngest first, under the specimen's preferred age; and their ideogram: each age as a normal curve of its σ, summed, each one faint. Total-fusion experiments with no steps are drawn here, and a specimen with no spectrum shows its ranked ages on its card and grid tile. |
| Specimen ages (contribution, and the Specimens search level) | Every specimen's preferred age as a histogram with the ideogram scaled to its tallest bin, the ages as ticks. Ages share the specimens' unit, or are converted to Ma when the units differ. |
| Age vs. elevation, stratigraphic height, core depth, composite depth | Each specimen's preferred age ± σ at its sample's `elevation`, `height` (± `height_sigma`), `core_depth` or `composite_depth`; depth increases downward. |
| J vs. irradiation position | Per `irrad_name`: each specimen's `j_value` ± `j_value_sigma` against its numbered `irrad_position`, else `irrad_z`, else its positions in order. Flux monitors (`is_flux_monitor`) are filled, the specimens they calibrate hollow. |

Each plot appears once its columns are filled, so the plots that few
contributions fill today (heights, depths, irradiation positions, Cl) appear
as data arrives.

An experiment's rows (one per `age_calculation_method`) are sorted onto the
plots by their method's text: anything containing "plateau", "isochron" (with
or without "inverse"), or "fusion" / "total gas". When a row lists no
intercepts, no ratios or no steps, the caption says so. Measurements are
matched to experiments exactly, or else on a hyphen-delimited prefix
("33922" ↔ "33922-01").

`GET /v2/{node}/plugins/plateau-calculations/contributions/{id}` returns
`{experiments, specimens, samples}`: the steps carry `k_ca`, `k_ca_sigma`,
`ar40_rad` and `cl_k`; the specimens their J and irradiation (`j_value`,
`j_value_sigma`, `irrad_name`, `irrad_position`, `irrad_x/y/z`,
`is_flux_monitor`); the samples their `elevation`, `height`, `height_sigma`,
`core_depth` and `composite_depth`. `?experiment=` or `?specimen=` narrows the
result, as the tiles do (`?specimen=` keeps its sample). The built data is cached per contribution revision, and
concurrent requests share a single download and parse.

UI: three contribution-modal asset tabs, laid out as MagIC's plot tabs are
(`fiesta/frontend/src/components/plot-grid.tsx`, shared with `pmag-plots`):
the selected plot drawn large, and every plot as a small card to pick from,
below it or in a column beside it, with a name filter.

- **Specimen Age Plots** (`specimen-age-plots`, counted by the first
  `specimen_levels` level): a specimen's experiments' spectra under its
  preferred age, with a legend, their ranked ages and ideogram, and links to
  each experiment's plots.
- **Experiment Age Plots** (`experiment-age-plots`, counted by the first
  `experiment_levels` level): an experiment's spectrum with its companion
  spectra, its isochrons and release curve with their captions, and every age
  contributed for it. The cards follow the specimens' order, then the
  experiments no specimen lists.
- **Contribution Age Plots** (`contribution-age-plots`, counted by the plots it
  has data for, hidden at none): the specimens' ages, age against each section
  column, and J against position per irradiation (`?plot=ages`, `elevation`,
  `height`, `core_depth`, `composite_depth`, `j:<irrad_name>`).

The levels in `specimen_levels` also get an **Age Distribution** result
sub-tab: every matching specimen's age (the search paged with only the age
fields, up to 10,000 matches) as a histogram and ideogram.

An experiment's spectrum is the `plot` tile of the levels in
`experiment_levels`, and the specimen view is the tile of the levels in
`specimen_levels`. A tile opens its tab with that item selected
(`?plot=<name>`).

Options (set in karar.yaml): `experiment_levels` and `specimen_levels`.

| File | What |
|---|---|
| `plugin.py` | `PlateauPlugin`: options, building the data from the parsed tables, the route |
| `argon-data.ts` | Response types, the query and hook, age and unit helpers |
| `argon-plots.tsx` | SVG frame, axes (linear and log) and ticks; age spectrum, isochrons and the specimen overlay |
| `argon-charts.tsx` | Companion spectra, release curve, ranked ages, ideogram (with histogram), x–y plot with error bars |
| `argon-summary.ts` | The contribution-wide plots built from the data (ages, sections, irradiations) |
| `argon-view.tsx` | The three modal tabs: the selected plot, its captions and ages table, the cards |
| `argon-search.tsx` | The specimen levels' Age Distribution sub-tab |
| `index.tsx` | The grid tiles, the tab and sub-tab registration |
| `test_plateau_calculations.py` | Contributed ages, ³⁹Ar sizing, isochron points, companion values, experiment, specimen, irradiation and sample linking |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
