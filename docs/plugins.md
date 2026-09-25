# FIESTA plugins

Plugins isolate node-specific features — science that belongs to one
repository (MagIC's paleomagnetic poles, CDR's core depth plots, KArAr's
⁴⁰Ar/³⁹Ar age plateaus) — from the config-driven core. All plugin code ships
with FIESTA; a node activates a plugin by listing it in its YAML:

```yaml
features:
  plugins: [poles]          # magic.yaml
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
  record-cards:
    cards:
      cores: { title_column: core, cells: [{ column: method, label: Method, width: 150 }] }
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
extra sub-tabs on a search level, filter overrides). A plugin's components
live under `src/plugins/<name>/` and activate only when the name appears in
`config.plugins` — nothing node-specific leaks into core components.

## The built-in plugins

- **`poles` (MagIC)** — derives a server-backed `poles` search level from
  location rows carrying `pole_lat`/`pole_lon` (the legacy app's Poles tab
  queried `type: "poles"` docs that nothing actually indexed; the plugin
  makes them real). UI: pole result items + an SVG pole map with α95 circles;
  the Age / A95 / Geospatial filters are `search.filters` entries. Options:
  `display_columns`, `base_level`, `after_sub_tab`, `age_color`,
  `plate_boundary_color`.
- **`depth-plot` (CDR)** — `GET /v2/{node}/plugins/depth-plot/contributions/{id}/measurements`
  returns depth-sorted measurement rows grouped by core (depth =
  the first of `depth_columns` present; the `series` tracks, matching the
  legacy view, are options in cdr.yaml). UI: multi-track SVG depth plots as a
  "Plots" sub-tab on the `levels` option's levels.
- **`plateau-calculations` (KArAr)** — Python port of the legacy
  `PlateauCalculations` class: per-step ages from ⁴⁰Ar*/³⁹ArK via
  `t = (1/λ)·ln(1 + J·R)` (λ = 5.543e-10/yr, atmospheric ⁴⁰Ar/³⁶Ar = 295.5),
  cumulative ³⁹Ar release, plateau = lowest-MSWD run of ≥3 consecutive steps
  spanning ≥50% ³⁹Ar with MSWD ≤ 2.5 — λ, J and the three plateau criteria
  are options (`default_lambda`, `default_j`, `min_plateau_steps`,
  `max_mswd`, `min_ar39_percent`), set in karar.yaml.
  `GET /v2/{node}/plugins/plateau-calculations/contributions/{id}/experiments/{name}/plateau`
  returns the full age spectrum + plateau. UI: age-spectrum thumbnail/modal
  on Experiments result items.
- **`record-cards` (ERDA, OSU-MGR)** — some nodes publish *records* rather than
  measurements: an ERDA digital object, an OSU-MGR core or dredged rock. The
  default result card (geologic classes, lithologies, method codes,
  intensities) has nothing to show for them. The plugin has no behaviour of
  its own: its `cards` option (in erda.yaml and osu-mgr.yaml) gives, per
  search table, the column that titles the card, an optional subtitle column
  and the columns that become cells; `check` rejects a card naming a table or
  column the data model does not have. UI: title + subtitle cards with the
  configured cells and human-readable file sizes.
