# FIESTA plugins

Plugins isolate node-specific features — science that belongs to one
repository (MagIC's paleomagnetic poles, CDR's core depth plots, KArAr's
⁴⁰Ar/³⁹Ar age spectra) — from the config-driven core. All plugin code ships
with FIESTA; a node activates a plugin by listing it in its YAML:

```yaml
features:
  plugins: [poles, rock-mag, pmag-plots, method-codes, sample-tiles] # magic.yaml
  plugins: [depth-plot]     # cdr.yaml
  plugins: [plateau-calculations]  # karar.yaml
  plugins: [periodic-table]  # kdd.yaml
  plugins: [geomag-series, field-models]  # geomagia.yaml
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

## One folder per plugin (`configurations/plugins/<name>/`)

Everything a plugin is lives in one folder, named after the plugin:

```
configurations/plugins/rock-mag/
  plugin.py            backend half: the FiestaPlugin subclass (imports as fiesta.plugins.rock_mag)
  index.tsx            UI half: default-exports the plugin's PluginModule
  rock-mag-view.tsx …  the rest of its UI
  test_rock_mag.py     its tests (collected by the backend suite)
  README.md            what it does, its options, its routes, its files
```

The folder is the registration: no list to edit on either side. The backend
loads every `*/plugin.py` under `FIESTA_PLUGINS_DIR` (default: `plugins/`
beside `FIESTA_CONFIG_FILE`), the frontend build every `*/index.tsx`, and both
key the plugin by its folder name, which must equal its `name`. The plugin
API stays in core: `fiesta/backend/fiesta/plugins/` (`base.FiestaPlugin`, `util`,
the loader) and `fiesta/frontend/src/plugins/index.tsx` (the UI contract and
registry). Plugin code may import core code; core code never imports a
plugin, only the registries.

Tooling reaches the folders from the usual places: `make lint`/`make fix`
run ruff and biome over `configurations/plugins`; `cd fiesta/backend && uv run pytest`
collects `configurations/plugins/*/test_*.py` (backend `testpaths`; a test file's
name must be unique across plugins); `npm run build` type-checks and bundles
the UI (frontend `tsconfig.json` includes `../../configurations/plugins`). In the
Docker images `configurations/plugins` is `/config/plugins` in the backend (its
`/config` mount) and `/configurations/plugins` in the frontend (its `plugins`
build context; that image mirrors the repo layout).

## Backend half (`plugin.py`)

Subclass `FiestaPlugin` (`fiesta.plugins.base`), set `name` (the folder
name), `description` and (if it has any settings) `Options`. Define exactly
one subclass per `plugin.py`; the loader instantiates it. Other modules and
tests import it as `fiesta.plugins.<name>` with dashes as underscores
(`from fiesta.plugins.rock_mag import rock_mag_values`). Optional hooks:

| Hook | When it runs | Use for |
|---|---|---|
| `check(node, options)` | startup and every validation / publication | reject options that do not fit this node (tables, columns, levels) with a `ValueError` |
| `jsonld(node, doc, catalog_url)` | every contribution JSON-LD (`/contributions/{id}/jsonld`, the page head crawlers read) | schema.org properties added to the contribution's `Dataset`: a list extends the core's, anything else fills a property the core left unset (method-codes: `measurementTechnique`) |
| `derive_docs(node, parsed, meta)` | every (re)process and `fiesta rebuild` | extra search documents derived from contribution rows (e.g. one `poles` doc per location row with `pole_lat`/`pole_lon`) — always reproducible from the bucket |
| `derived_columns(node)` + `derive_values(node, table, rows)` | every (re)process and `fiesta rebuild` | extra columns on the hierarchy's own record docs, from each record's rows (`fiesta.plugins.add_derived_values`): a "text" one is a `summary._all.<name>` keyword (a YAML `facet` filter, `<name>:"<value>"` tokens), a "number" one `summary._num.<name>` (a YAML `range` filter and its histogram); the contribution doc gets the union of its records'. The node checks accept YAML filters on them as on data-model columns (a name must not be one). E.g. `geomag-series`'s `data_type`, `pi_family`, `age_error` |
| `search_levels(node)` | config load | extra search tabs; merged into `GET /v2/{node}/config` `search_levels` and the search API's allowed tables |
| `search_facets(node)` | every search request with `facet=` | extra columns the search API counts as facet buckets for the plugin's own sidebar filter (the periodic table's `element`); a pick is the usual `<column>:"<value>"` query token |
| `build_router()` | app startup | API routes mounted once at `/v2/{repository}/plugins/{name}` (e.g. plot-ready measurement series, age spectra); handlers read the node from `NodeDep`. The router is guarded so a node that does not activate the plugin gets a 404 |
| `frontend_config(node)` | `GET /v2/{node}/config` | arbitrary JSON under `plugins[name]` telling the UI plugin what to mount and with which options |
| `vocabularies(node)` | every validation; `GET /config/vocabularies/plugins` | `{name: PluginVocabulary(items, case_insensitive, label, labels)}`: the list a `cv("<name>")` data-model validation checks when the node's controlled vocabularies have none of that name (method codes). `label` (the list's title) and `labels` (item → definition) are optional; the grid editor's pulldowns and vocabulary panel show them |
| `upgrade_steps(node)` | every upload or import in an older data-model version; `POST /upgrade` | `UpgradeStep`s (`fiesta.domain.upgrade`) for the version steps whose restructuring the data models' `previous_columns` cannot express: `prepare` (whole old tables), `map_row` (a `RowPlan`: the row, the new tables it may feed, values to add as they are), `map_value`, `finish_row` (blank defaults, each a `BlankDefault` the contributor can switch), `finish`, plus `merge_keys`, `retired_tables` and `quiet_columns`. The core does the renames, splits, merges and row merging from the models; at most one active plugin supplies a step |
| `grid_tiles` (class attribute) | config load | the summary grid tiles it adds, `GridTile(cell, label, width, hint, default)`: a node that activates it may name them in `search.levels[].columns`, and `default` ones are columns of every level that configures none (after the core's `geo`, before `citations`); the admin UI's Summary Grid tab offers them. Its UI renders them through `gridCell` |
| `grid_tile_fields(node, level, cell)` | config load, every search | a tile's default sort (`sort_fields`, `sort_type`), text filter fields and facets (`GridTileFields`), from the plugin's options; a column's YAML may replace them |
| `pages` (class attribute) | startup and every validation | slugs of the SPA pages its UI registers (`pages` below); no node's content page may take one |

`active_plugins(node)` also refuses a grid column naming a tile that neither
the core nor an active plugin has, and a content page on a plugin page's slug.

Paleo- and rock-magnetic science comes from PmagPy (`pmagpy`, a backend
dependency) wherever it has the function: `from pmagpy import pmag` at module
level (~1 s, numpy/scipy/pandas/matplotlib); `pmagplotlib` and `ipmag` only
inside functions (importing `pmagplotlib` prints a cartopy notice and silences
warnings process-wide; see the `poles` plugin's `_plot_ell`); never cartopy.
PmagPy raises on blank or malformed legacy rows, so clean them first and keep
one bad row from failing `derive_docs` or a route. Geometry the UI draws
(projections, circles, ellipses) is computed here too, with PmagPy, and the TS
only draws it; geometry stored on a search doc goes under a `_geometry` object,
which the index keeps in `_source` but never indexes.

Plugin routes read contribution data through
`fiesta.plugins.util.load_visible_parsed`, which enforces the same
visibility rules as the core API (activated, or matching private key) and
parses the canonical file from the bucket.

## UI half (`index.tsx`)

`index.tsx` default-exports a `PluginModule` (`fiesta/frontend/src/plugins/index.tsx`):
custom result items and grid tiles, extra sub-tabs on a search level, filter
overrides, home-page cards, and `contributionTabs` — asset tabs in the
contribution modal, each counted by the matches of an optional `countTable`
in that contribution and hidden when there are none.

A level sub-tab (`levelSubTabs`) shows either its own docs (`countTable`,
e.g. `rock_mag`: it fetches them with the context's `query`, `ranges` and
`bbox`, and the sidebar counts them) or, with `records: true`, the level's own
records drawn another way, as Map draws them (`geomag-series`'s Plots): the
sidebar's filters, area, grid filters and with/without data apply as on
Summaries, its count is the level's, and it fetches the matches with the
context's `searchParams` (the level search's request params) from
`GET /search/{table}/values`.

`sidebarFilters(levelName, subTabName, config)` adds filters to the facet
sidebar after the node's own (`filtersPanel` instead replaces the whole
sidebar). Each `PluginFilter` names the query-token `fields` it sets, so the
sidebar's Clear removes them, and renders from a `PluginFilterContext`: the
search's `q` and `setQuery`, the `table` its counts are on, `paramsFor(q)`
(the request params a core facet modal counts with: ranges, bbox, grid
filters, scope), the open sub-tab's bucket `count`, and `filterCount`, how
many matches have a value in its first field (the host counts it as a
`facet:<field>` with the sidebar's other counts; pass it to `FilterEntry`:
undefined is its spinner, so an entry without a count passes null). A pick is a
`<field>:"<value>"` token, OR'd within the field like a facet's values; the
plugin counts the field with `facet: [field]`, which the search API accepts
once the backend half lists it in `search_facets`. The periodic table is the
example: a `FilterEntry` whose modal is the table. It activates only when
the plugin's name appears in `config.plugins`, so nothing node-specific leaks
into core components. The hooks besides those above:

| Hook | Use for |
|---|---|
| `pages` | SPA pages at their own paths (`{path: "/method-codes", component, validateSearch?}`): every plugin's are routes (the router is built once), each a not-found page on a node that does not activate it; their slugs are the backend plugin's `pages` |
| `resourceCards(config)` | `HomeCard`s for the home page's default resource row (a node YAML without `features.home.resources`), after its Data Model card |
| `facetDescriptions(config)` | a query (`{queryKey, queryFn, select}`, select giving `Map<value, {definition, group, order}>`) whose values' definitions the filter modals show beside any facet's values, grouped and ordered as given |

Plugin files import core code through the `@/` alias (`@/lib/api`,
`@/components/echart`, `@/plugins` for the types) and npm packages as usual;
both resolve from `fiesta/frontend/` (Vite's `resolve.dedupe` and the tsconfig
`paths` fallback), so a plugin that needs a new package adds it to
`fiesta/frontend/package.json`. Tailwind scans the folder (`@source` in
`src/index.css`).

Colors follow the light/dark theme through tokens, not literals: `bg-surface`
(not `bg-white`), `text-ink`/`-muted`/`-faint`, `border-line`/`border-edge`,
`bg-panel`, and the gray palette, which dark mode remaps; `text-node-ink` for
node-colored text. Plots follow the theme too: an SVG chart uses the
`--er-plot-*` tokens (`var(--er-plot-net)`, …) or the gray palette as `var()`;
an echarts option reads `plotColors()` (`@/lib/plot-colors`: text, grid, axis,
net, surface for marker halos, the node color lightened in dark mode) inside
`build`, which `EChart` re-runs on a theme switch (a memoized series takes
`usePlotColors()` as a dependency). Data colors (red/blue series) stay as they are.

## The plugins

| Plugin | Node | What |
|---|---|---|
| [`poles`](../configurations/plugins/poles/README.md) | MagIC | a `poles` search level from location poles; the MapLibre pole maps with plate boundaries and α95 / dp-dm outlines |
| [`rock-mag`](../configurations/plugins/rock-mag/README.md) | MagIC | a `rock_mag` doc per rock-magnetic result; the linked panels (Day plot, squareness–coercivity, critical temperatures, Jelinek, V1/V3 stereonet) |
| [`pmag-plots`](../configurations/plugins/pmag-plots/README.md) | MagIC | the PmagPy plots (equal area, Zijderveld, demagnetization, Arai, deremagnetization, hysteresis), drawn interactively |
| [`depth-plot`](../configurations/plugins/depth-plot/README.md) | CDR | depth-sorted measurement tracks per core |
| [`plateau-calculations`](../configurations/plugins/plateau-calculations/README.md) | KArAr | ⁴⁰Ar/³⁹Ar age spectra, isochrons and specimen ages, as contributed |
| [`method-codes`](../configurations/plugins/method-codes/README.md) | MagIC | the method-code vocabulary: the Method Codes page and home card, code definitions beside facet values, case-insensitive `cv()` validation |
| [`sample-tiles`](../configurations/plugins/sample-tiles/README.md) | every node | the Geology, Age, Intensity and Method Codes summary grid tiles (the legacy result card's sample columns), default tiles after Geography |
| [`periodic-table`](../configurations/plugins/periodic-table/README.md) | KdD | a periodic-table element filter in the search sidebar, each element counted in the search |
| [`magic-3-upgrade`](../configurations/plugins/magic-3-upgrade/README.md) | MagIC | the 2.5 → 3.0 upgrade step: results split by level and direction, the wide criteria table, method codes, dates, measurement parents and sequence, the 2.5 blank defaults |
| [`geomag-series`](../configurations/plugins/geomag-series/README.md) | GEOMAGIA | the Sites level's Plots sub-tab (intensity or VADM, declination and inclination against age, linked zoom, PNG export), and the GEOMAGIA site's query refinements: derived facets and ranges, site-name and radius searches |
| [`field-models`](../configurations/plugins/field-models/README.md) | GEOMAGIA | the Sites level's Field Models sub-tab: published geomagnetic field models (SHMODEL in numpy) as intensity/VADM, declination and inclination/ΔI curves at chosen or searched site locations with uncertainty bands, ensembles and the search's data, global Mollweide maps with a year movie, GEOMAGIA's exports; models fetched from their public sources into storage by its `fetch_models.py` |
| [`kd-plots`](../configurations/plugins/kd-plots/README.md) | KdD | spider diagrams, Onuma (Kd against ionic radius) diagrams and Kd by element, for a search or a contribution |

Retired: **`record-cards`** (ERDA, OSU-MGR) was retired on 2026-09-30: its per-table
  card layout (title column, subtitle, cells) is now core configuration, each
  search level's summary grid `columns` (`title` and `field` columns, see
  api.md "Summary grid"), and the node loader checks their columns against the
  data model as the plugin's `check` did.
