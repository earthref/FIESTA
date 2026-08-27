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

## Backend half (`backend/fiesta/plugins/`)

Subclass `FiestaPlugin` and register it in `fiesta/plugins/__init__.py`.
Four optional hooks:

| Hook | When it runs | Use for |
|---|---|---|
| `derive_docs(node, parsed, meta)` | every (re)process and `fiesta rebuild` | extra search documents derived from contribution rows (e.g. one `poles` doc per location row with `pole_lat`/`pole_lon`) — always reproducible from the bucket |
| `search_levels(node)` | config load | extra search tabs; merged into `GET /api/config` `search_levels` and the search API's allowed tables |
| `build_router(node)` | app startup | API routes mounted at `/api/plugins/{name}` (e.g. plot-ready measurement series, plateau computation) |
| `frontend_config(node)` | `GET /api/config` | arbitrary JSON under `plugins[name]` telling the UI plugin what to mount and with which options |

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
  makes them real). UI: pole result items + an SVG pole map with α95 circles
  and a reduced filter set.
- **`depth-plot` (CDR)** — `GET /api/plugins/depth-plot/contributions/{id}/measurements`
  returns depth-sorted measurement rows grouped by core (depth =
  `mbs_corrected` falling back to `depth`; ten series tracks matching the
  legacy view). UI: multi-track SVG depth plots as a "Plots" sub-tab on the
  Cores level.
- **`plateau-calculations` (KArAr)** — Python port of the legacy
  `PlateauCalculations` class: per-step ages from ⁴⁰Ar*/³⁹ArK via
  `t = (1/λ)·ln(1 + J·R)` (λ = 5.543e-10/yr, atmospheric ⁴⁰Ar/³⁶Ar = 295.5),
  cumulative ³⁹Ar release, plateau = lowest-MSWD run of ≥3 consecutive steps
  spanning ≥50% ³⁹Ar with MSWD ≤ 2.5.
  `GET /api/plugins/plateau-calculations/contributions/{id}/experiments/{name}/plateau`
  returns the full age spectrum + plateau. UI: age-spectrum thumbnail/modal
  on Experiments result items.
- **`record-cards` (ERDA, OSU-MGR)** — some nodes publish *records* rather than
  measurements: an ERDA digital object, an OSU-MGR core or dredged rock. The
  default result card (geologic classes, lithologies, method codes,
  intensities) has nothing to show for them. The plugin is config-only on the
  backend: `frontend_config` returns, per search table, the column that titles
  the card and the columns that become cells, and fails at startup if a card
  names a table the node's data model does not have. UI: title + subtitle
  cards with the configured cells and human-readable file sizes.
