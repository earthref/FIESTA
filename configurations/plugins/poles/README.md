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
`fiesta/frontend/src/components/map/lines-layer.ts`); also the contribution modal's
Poles tab. The map draws every matching pole (paged 1,000 at a time with
`/search/poles?source=…`, only the fields it draws, up to the 10,000-doc
search window; past ~1,000 poles their rings are thinned to a fixed segment
budget) and fills the view but for two grid rows; under it every pole is a
row of a scrolling, virtual Summaries grid (full docs fetched for the rows in
view, in the map's order, so a pole's index is its row): the core tiles
(record, the location's map, geography, geology, method codes, citations,
all read from the doc's location row) and the plugin's own via `gridCell`
(the pole on a whole-globe thumbnail with its ring, pole statistics, age,
direction). Choosing a pole on the map highlights and scrolls to its row,
a row's first click selects its pole (drawn on top of the others, the map
turning or panning to centre it), and a
second click on the selected row opens its contribution on the location row.
The map is never taller than it is wide, leaving the grid at least two rows.
The Age / A95 / Geospatial filters are `search.filters` entries; a search
page arriving on the view with no filters and more than
`default_alpha95_above` poles sets the Pole A95 filter to ≤
`default_alpha95_max`° once (clearing it shows every pole).

Options: `display_columns`, `base_level`, `after_sub_tab`, `age_color`,
`plate_boundary_color`, `default_alpha95_max` (10; null for no default
filter), `default_alpha95_above` (1000), `facet_columns` (the location
columns a pole doc's `summary._all` carries, lists split).

API: `GET /v2/{node}/plugins/poles/plate-boundaries`.

| File | What |
|---|---|
| `plugin.py` | `PolesPlugin`: options, derived `poles` docs and their PmagPy uncertainty rings, the plate-boundaries route |
| `index.tsx` | the UI module: the map over the poles' grid and its tiles, the Locations sub-tab, the contribution modal's Poles tab |
| `poles-map.tsx`, `poles-data.ts` | the map views; reading poles and their rings from the docs, age colours, plate-boundary rings split at the date line |
| `test_poles.py` | derived docs, the rings (α95 radius, dp/dm orientation, date line, malformed values) and the sub-tab wiring |
| `globe-spec.md` | the map views' spec and its deviations from the legacy globe |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
