# `poles` (MagIC)

Derives a server-backed `poles` search level from location rows carrying
`pole_lat`/`pole_lon` (the legacy app's Poles tab queried `type: "poles"` docs
that nothing actually indexed; the plugin makes them real).

UI: pole result items + the search map's MapLibre views (globe, Mercator,
north and south pole) with the plate boundaries and each pole's uncertainty
outline in its age colour — its α95 circle, else its dp/dm oval oriented along
the site–pole great circle — drawn by a custom WebGL line layer that, unlike
MapLibre's GeoJSON lines, reaches past ±85° (core
`frontend/src/components/map/lines-layer.ts`); also the contribution modal's
Poles tab. The Age / A95 / Geospatial filters are `search.filters` entries.

Options: `display_columns`, `base_level`, `after_sub_tab`, `age_color`,
`plate_boundary_color`.

API: `GET /v2/{node}/plugins/poles/plate-boundaries`.

| File | What |
|---|---|
| `plugin.py` | `PolesPlugin`: options, derived `poles` docs, the plate-boundaries route |
| `index.tsx` | the UI module: result items, the Locations sub-tab, the contribution modal's Poles tab |
| `poles-map.tsx`, `poles-data.ts` | the map views and the pole/outline geometry |
| `test_poles.py` | derived docs and the sub-tab wiring |
| `globe-spec.md` | the map views' spec and its deviations from the legacy globe |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
