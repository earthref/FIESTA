# `rock-mag` (MagIC)

Derives a `rock_mag` search doc from every rock-magnetic result of a
`source_table` (specimens) record: a specimen's rows with complementary
parameters (hysteresis, anisotropy, a Curie temperature) are one result, and a
row repeating parameters (hysteresis at another temperature) is another, so
each is one point on the plots and the view counts results and their
specimens.

`summary.rock_mag` holds numbers in consistent units: Mr/Ms, Bcr/Bc, Bc, Bcr
and MDF (mT), Ms, Mr, χ, κ, χfd, S-ratio, critical temperature (°C),
anisotropy P, P′, T, L, F (Jelinek 1981, from the eigenparameters or the
`aniso_s` tensor) and the V1/V3 axes (only outside specimen coordinates).
Ratios are derived from their parts when a row lacks them, non-physical values
are left out, and a contribution whose field column's median is above 1 T is
read as mT (common in legacy data). A specimen takes its position and facet
values from its sample or site.

UI: a Rock Magnetism sub-tab of `base_level` (Specimens), a home-page card,
and the contribution modal's Rock Magnetism tab — linked echarts panels (Day
plot with the Day et al. 1977 domain fields, squareness–coercivity with the
uniaxial/cubic SD limits, critical temperatures against those of common
minerals, Jelinek plot, equal-area stereonet of V1/V3, a distribution of any
parameter, and an X–Y explorer), colour by lithology / geologic class / type /
transition type, brushing any panel selects those specimens on all of them and
lists them, CSV download. The plots read `GET /search/rock_mag/values`; the
range filters are `search.filters` entries on `summary.rock_mag.<field>`.

Options: `base_level`, `source_table`.

| File | What |
|---|---|
| `plugin.py` | `RockMagPlugin`: options, unit handling, derived `rock_mag` docs |
| `index.tsx` | the UI module: home card, Specimens sub-tab, contribution modal tab |
| `rock-mag-view.tsx`, `rock-mag-data.ts` | the linked panels and their data shaping |
| `test_rock_mag.py` | derived docs, results per specimen, units, tensor-derived values |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
