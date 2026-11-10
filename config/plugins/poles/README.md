# `poles` (MagIC)

Derives a server-backed `poles` search level from location rows carrying
`pole_lat`/`pole_lon` (the legacy app's Poles tab queried `type: "poles"` docs
that nothing actually indexed; the plugin makes them real).

Each pole doc carries its uncertainty outline, computed with PmagPy when the
doc is derived: the α95 circle (`pmag.circ`, the pole's lon/lat as a dec/inc),
else the dp/dm ellipse (`pmagplotlib.plot_ell`) with dp along the great
circle from the pole toward the location's position (its lat/lon, else the
middle of its lat/lon box; the azimuth from `pmag.vgp_di`, the axes placed
with `pmag.dodirot`). It is stored at `summary.poles._geometry` =
`{"kind": "alpha95" | "dp_dm", "ring": [[lon, lat], ...]}` — 101 points,
closed, longitudes −180..180, 2 decimals — which the index maps
`enabled: false` (core `fiesta/search/index.py`): returned with the doc, never
searched, faceted or in `summary._all`. A blank, malformed or out-of-range
α95 / dp / dm (outside (0, 90]°) or position gives no ring; a PmagPy error on
one row only drops that row's ring. Docs indexed before the rings existed draw
no outline until `fiesta rebuild`.

UI: pole result items + the search map's MapLibre views (globe, Mercator,
north and south pole) with the plate boundaries and each pole's uncertainty
outline (the doc's ring) in its age colour, drawn by a custom WebGL line
layer that, unlike
MapLibre's GeoJSON lines, reaches past ±85° (core
`frontend/src/components/map/lines-layer.ts`); also the contribution modal's
Poles tab. Above the map, the selected pole (the first, until another is
picked) is a one-row Summaries grid: the core tiles (record, the location's
map, geography, geology, method codes, citations, all read from the doc's
location row) and the plugin's own via `gridCell` (the pole on a map
thumbnail with its ring, pole statistics, age, direction). The Age / A95 / Geospatial filters are `search.filters` entries.

Options: `display_columns`, `base_level`, `after_sub_tab`, `age_color`,
`plate_boundary_color`.

API: `GET /v2/{node}/plugins/poles/plate-boundaries`.

| File | What |
|---|---|
| `plugin.py` | `PolesPlugin`: options, derived `poles` docs and their PmagPy uncertainty rings, the plate-boundaries route |
| `index.tsx` | the UI module: the selected pole's card and its grid tiles, the Locations sub-tab, the contribution modal's Poles tab |
| `poles-map.tsx`, `poles-data.ts` | the map views; reading poles and their rings from the docs, age colours, plate-boundary rings split at the date line |
| `test_poles.py` | derived docs, the rings (α95 radius, dp/dm orientation, date line, malformed values) and the sub-tab wiring |
| `globe-spec.md` | the map views' spec and its deviations from the legacy globe |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
