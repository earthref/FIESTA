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

## One folder per plugin (`config/plugins/<name>/`)

Everything a plugin is lives in one folder, named after the plugin:

```
config/plugins/rock-mag/
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
API stays in core: `backend/fiesta/plugins/` (`base.FiestaPlugin`, `util`,
the loader) and `frontend/src/plugins/index.tsx` (the UI contract and
registry). Plugin code may import core code; core code never imports a
plugin, only the registries.

Tooling reaches the folders from the usual places: `make lint`/`make fix`
run ruff and biome over `config/plugins`; `cd backend && uv run pytest`
collects `config/plugins/*/test_*.py` (backend `testpaths`; a test file's
name must be unique across plugins); `npm run build` type-checks and bundles
the UI (frontend `tsconfig.json` includes `../config/plugins`). In the
Docker images `config/plugins` is `/config/plugins` — the backend's
`/config` mount, and the frontend image's `plugins` build context.

## Backend half (`plugin.py`)

Subclass `FiestaPlugin` (`fiesta.plugins.base`), set `name` (the folder
name), `description` and (if it has any settings) `Options`. Define exactly
one subclass per `plugin.py`; the loader instantiates it. Other modules and
tests import it as `fiesta.plugins.<name>` with dashes as underscores
(`from fiesta.plugins.rock_mag import rock_mag_values`). Optional hooks:

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

## UI half (`index.tsx`)

`index.tsx` default-exports a `PluginModule` (`frontend/src/plugins/index.tsx`):
custom result items and grid tiles, extra sub-tabs on a search level, filter
overrides, home-page cards, and `contributionTabs` — asset tabs in the
contribution modal, each counted by the matches of an optional `countTable`
in that contribution and hidden when there are none. It activates only when
the plugin's name appears in `config.plugins`, so nothing node-specific leaks
into core components.

Plugin files import core code through the `@/` alias (`@/lib/api`,
`@/components/echart`, `@/plugins` for the types) and npm packages as usual;
both resolve from `frontend/` (Vite's `resolve.dedupe` and the tsconfig
`paths` fallback), so a plugin that needs a new package adds it to
`frontend/package.json`. Tailwind scans the folder (`@source` in
`src/index.css`).

## The plugins

| Plugin | Node | What |
|---|---|---|
| [`poles`](../config/plugins/poles/README.md) | MagIC | a `poles` search level from location poles; the MapLibre pole maps with plate boundaries and α95 / dp-dm outlines |
| [`rock-mag`](../config/plugins/rock-mag/README.md) | MagIC | a `rock_mag` doc per rock-magnetic result; the linked panels (Day plot, squareness–coercivity, critical temperatures, Jelinek, V1/V3 stereonet) |
| [`pmag-plots`](../config/plugins/pmag-plots/README.md) | MagIC | the PmagPy plots (equal area, Zijderveld, demagnetization, Arai, deremagnetization, hysteresis), drawn interactively |
| [`depth-plot`](../config/plugins/depth-plot/README.md) | CDR | depth-sorted measurement tracks per core |
| [`plateau-calculations`](../config/plugins/plateau-calculations/README.md) | KArAr | ⁴⁰Ar/³⁹Ar age spectra and plateaus |

Retired: **`record-cards`** (ERDA, OSU-MGR) was retired on 2026-09-30: its per-table
  card layout (title column, subtitle, cells) is now core configuration, each
  search level's summary grid `columns` (`title` and `field` columns, see
  api.md "Summary grid"), and the node loader checks their columns against the
  data model as the plugin's `check` did.
