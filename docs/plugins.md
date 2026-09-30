# FIESTA plugins

Plugins isolate node-specific features — science that belongs to one
repository (MagIC's paleomagnetic poles, CDR's core depth plots, KArAr's
⁴⁰Ar/³⁹Ar age plateaus) — from the config-driven core. All plugin code ships
with FIESTA; a node activates a plugin by listing it in its YAML:

```yaml
features:
  plugins: [poles, rock-mag, pmag-plots] # magic.yaml
  plugins: [depth-plot]     # cdr.yaml
  plugins: [plateau-calculations]  # karar.yaml
```

Unknown names fail at startup, not at request time.

Whatever a plugin lets a node tune is an **option**: the plugin declares an
`Options` pydantic model (fields with defaults, descriptions and constraints)
and the node sets values under the YAML's top-level `plugins` map:

```yaml
plugins:
  poles:
    base_level: Locations
    display_columns: [pole_lat, pole_lon, pole_alpha95, age, age_unit]
  depth-plot:
    levels: [Cores]
```

`fiesta.plugins.active_plugins` validates the map at startup and before every
publication: unknown plugin names, unknown option keys and values outside the
schema are errors, and a plugin's `check(node, options)` hook can reject
options against the node (a card for a table the data model lacks, a level
that does not exist). Options of a plugin that is configured but not
activated are validated too, so switching it on cannot fail. The admin UI's
Plugins tab lists every plugin with its description, switches it on or off
per node and edits its options through a form generated from the model's
JSON schema. A plugin never keys behaviour on a node name; it reads
`self.options(node)`.

## Backend half (`backend/fiesta/plugins/`)

Subclass `FiestaPlugin`, set `name`, `description` and (if it has any
settings) `Options`, and register it in `fiesta/plugins/__init__.py`.
Optional hooks:

| Hook | When it runs | Use for |
|---|---|---|
| `check(node, options)` | startup and every validation / publication | reject options that do not fit this node (tables, columns, levels) with a `ValueError` |
| `derive_docs(node, parsed, meta)` | every (re)process and `fiesta rebuild` | extra search documents derived from contribution rows (e.g. one `poles` doc per location row with `pole_lat`/`pole_lon`) — always reproducible from the bucket |
| `search_levels(node)` | config load | extra search tabs; merged into `GET /v2/{node}/config` `search_levels` and the search API's allowed tables |
| `build_router()` | app startup | API routes mounted once at `/v2/{repository}/plugins/{name}` (e.g. plot-ready measurement series, plateau computation); handlers read the node from `NodeDep`. The router is guarded so a node that does not activate the plugin gets a 404 |
| `frontend_config(node)` | `GET /v2/{node}/config` | arbitrary JSON under `plugins[name]` telling the UI plugin what to mount and with which options |

Plugin routes read contribution data through
`fiesta.plugins.util.load_visible_parsed`, which enforces the same
visibility rules as the core API (activated, or matching private key) and
parses the canonical file from the bucket.

## Frontend half (`frontend/src/plugins/`)

`src/plugins/index.tsx` maps plugin names to UI hooks (custom result items,
extra sub-tabs on a search level, filter overrides, and `contributionTabs`:
asset tabs in the contribution modal, each counted by the matches of an
optional `countTable` in that contribution and hidden when there are none).
A plugin's components
live under `src/plugins/<name>/` and activate only when the name appears in
`config.plugins` — nothing node-specific leaks into core components.

## The built-in plugins

- **`poles` (MagIC)** — derives a server-backed `poles` search level from
  location rows carrying `pole_lat`/`pole_lon` (the legacy app's Poles tab
  queried `type: "poles"` docs that nothing actually indexed; the plugin
  makes them real). UI: pole result items + the search map's MapLibre views
  (globe, Mercator, north and south pole) with the plate boundaries and each
  pole's uncertainty outline in its age colour — its α95 circle, else its
  dp/dm oval oriented along the site–pole great circle — drawn by a custom
  WebGL line layer that, unlike MapLibre's GeoJSON lines, reaches past ±85°
  (`components/map/lines-layer.ts`); also the contribution modal's Poles tab.
  The Age / A95 / Geospatial filters are `search.filters` entries. Options:
  `display_columns`, `base_level`, `after_sub_tab`, `age_color`,
  `plate_boundary_color`.
- **`rock-mag` (MagIC)** — derives a `rock_mag` search doc from every
  rock-magnetic result of a `source_table` (specimens) record: a specimen's
  rows with complementary parameters (hysteresis, anisotropy, a Curie
  temperature) are one result, and a row repeating parameters (hysteresis at
  another temperature) is another, so each is one point on the plots and the
  view counts results and their specimens; `summary.rock_mag`
  holds numbers in consistent units: Mr/Ms, Bcr/Bc, Bc, Bcr and MDF (mT),
  Ms, Mr, χ, κ, χfd, S-ratio, critical temperature (°C), anisotropy P, P′,
  T, L, F (Jelinek 1981, from the eigenparameters or the `aniso_s` tensor)
  and the V1/V3 axes (only outside specimen coordinates). Ratios are derived
  from their parts when a row lacks them, non-physical values are left out,
  and a contribution whose field column's median is above 1 T is read as mT
  (common in legacy data). A specimen takes its position and facet values
  from its sample or site. UI: a Rock Magnetism sub-tab of `base_level`
  (Specimens), a home-page card, and the contribution modal's Rock
  Magnetism tab — linked echarts panels (Day plot with the Day et al. 1977
  domain fields, squareness–coercivity with the uniaxial/cubic SD limits,
  critical temperatures against those of common minerals, Jelinek plot,
  equal-area stereonet of V1/V3, a distribution of any parameter, and an X–Y
  explorer), colour by lithology / geologic class / type / transition type,
  brushing any panel selects those specimens on all of them and lists them,
  CSV download. The plots read `GET /search/rock_mag/values`; the range
  filters are `search.filters` entries on `summary.rock_mag.<field>`.
  Options: `base_level`, `source_table`.
- **`pmag-plots` (MagIC)** — the legacy site's cached PmagPy plot images
  (`make_magic_plots.py`), drawn interactively instead: one contribution-modal
  tab per plot type with a count — Equal Area, Zijderveld, Demagnetization,
  Arai, Deremagnetization, Hysteresis (the Pole Map is the `poles` plugin's
  Poles tab). The backend groups and pairs the measurements with ports of the
  pmag.py functions the plots need rather than a PmagPy dependency
  (matplotlib/pandas/scipy): `dir2cart`, `dogeo`, `dotilt`, `fisher_mean` and
  sortarai's zero-field/in-field pairing. Demagnetization steps are a
  specimen's LT-NO / LT-AF-Z / LT-T-Z / LT-M-Z / LT-LT-Z rows (its
  paleointensity experiment's zero-field steps when it has no other), in
  specimen coordinates and, from the sample's `azimuth`/`dip` and
  `bed_dip_direction`/`bed_dip`, geographic and tilt-corrected ones, with the
  specimens table's fits (DE-BFL lines, DE-BFP planes). Arai steps are a
  specimen's LP-PI-TRM measurements, excluding anisotropy and cooling-rate
  steps that reuse LT-T-I: NRM remaining |Z| against pTRM gained |I − Z|
  over the NRM, pTRM checks against the zero-field step before them, tail
  checks, and the published interpretation's slope over its steps times its
  correction factors (on contribution 20557 it reproduces every `int_abs` to
  within 1%). Equal Area also plots the sites of each location and the
  samples and specimens of each site, with Fisher means. A hysteresis loop
  plots in `sequence` order (file order when a row has none), after
  restoring numbers that lost their trailing zeros in a spreadsheet (…9009,
  901, 9011… — contributions 20340 and 20710); the other plots in file order. `summary.pmag_plots` of one `pmag_plots` doc per contribution holds
  the counts; `GET /v2/{node}/plugins/pmag-plots/contributions/{id}/{kind}`
  (`demag`, `eqarea`, `arai`, `hyst`) serves the plot data, parsed once per
  contribution revision and cached. UI: a filterable grid of echarts plots
  with a coordinate-system and level switch; a plot enlarges with its
  neighbours a click away, wheel zoom, and step values on hover. Options:
  `plot_types` (the tabs, in order).
- **`depth-plot` (CDR)** — `GET /v2/{node}/plugins/depth-plot/contributions/{id}/measurements`
  returns depth-sorted measurement rows grouped by core (depth =
  the first of `depth_columns` present; the `series` tracks, matching the
  legacy view, are options in cdr.yaml). UI: multi-track SVG depth plots as a
  "Plots" sub-tab on the `levels` option's levels, and the contribution modal's
  Depth Plots tab.
- **`plateau-calculations` (KArAr)** — Python port of the legacy
  `PlateauCalculations` class: per-step ages from ⁴⁰Ar*/³⁹ArK via
  `t = (1/λ)·ln(1 + J·R)` (λ = 5.543e-10/yr, atmospheric ⁴⁰Ar/³⁶Ar = 295.5),
  cumulative ³⁹Ar release, plateau = lowest-MSWD run of ≥3 consecutive steps
  spanning ≥50% ³⁹Ar with MSWD ≤ 2.5 — λ, J and the three plateau criteria
  are options (`default_lambda`, `default_j`, `min_plateau_steps`,
  `max_mswd`, `min_ar39_percent`), set in karar.yaml.
  `GET /v2/{node}/plugins/plateau-calculations/contributions/{id}/experiments/{name}/plateau`
  returns the full age spectrum + plateau. UI: an age-spectrum thumbnail on
  Experiments rows (the summary grid's `plot` tile), opening the contribution modal's Age Spectra tab
  (every experiment's spectrum and plateau).
- **`record-cards`** (ERDA, OSU-MGR) was retired on 2026-09-30: its per-table
  card layout (title column, subtitle, cells) is now core configuration, each
  search level's summary grid `columns` (`title` and `field` columns, see
  api.md "Summary grid"), and the node loader checks their columns against the
  data model as the plugin's `check` did.
