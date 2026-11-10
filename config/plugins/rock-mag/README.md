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
`aniso_s` tensor), the V1/V3 axes (only outside specimen coordinates) and
their position on the equal-area net (`v1_x`, `v1_y`, `v3_x`, `v3_y`: x east,
y north on the unit lower-hemisphere net). Ratios are derived from their parts
when a row lacks them, non-physical values are left out, and a contribution
whose field column's median is above 1 T is read as mT (common in legacy
data). A specimen takes its position and facet values from its sample or
site.

**PmagPy** (`pmagpy.pmag`) does the paleomagnetic geometry:

- `pmag.doseigs` (`s2a` + `tauV` + `cart2dir`) gives an `aniso_s` tensor's
  eigenvalues (normalized to unit trace) and, when the row has no
  `aniso_v1..3` and its `aniso_tilt_correction` is 0 or 100, its V1/V3 axes
  (lower hemisphere). A blank tilt correction is specimen coordinates for a
  tensor, as PmagPy reads it; eigenparameter axes keep counting as in the
  world unless they say -1. Where `tauV` leaves the middle eigenvalue at 0
  (two equal eigenvalues) it is recovered from the unit trace and the
  undefined axis left out; a tensor without a positive trace, or one PmagPy
  raises on, gives no eigenvalues.
- `pmag.dimap` projects every V1/V3 axis (an upward one as its
  lower-hemisphere opposite) onto the net, so the stereonet only draws.

Custom, because PmagPy has no equivalent: P′, T, L, F (`anisotropy_shape`;
PmagPy computes only P = k1/k3, inline), parsing the `tau:dec:inc` eigenparameters,
the hysteresis ratios and their non-physical-value filters, the mT-vs-T
median heuristic (`field_units`), K→°C, and grouping a specimen's rows into
results. The Day-plot domain lines (0.05/0.5, 1.5/4) and the SD squareness and
mineral transition temperatures are reference constants in the UI; they are
the same as `pmagpy.rockmag.plot_day`'s defaults (`rockmag` imports
matplotlib, so it is not imported here).

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
| `plugin.py` | `RockMagPlugin`: options, unit handling, PmagPy eigen-decomposition and projection, derived `rock_mag` docs |
| `index.tsx` | the UI module: home card, Specimens sub-tab, contribution modal tab |
| `rock-mag-view.tsx`, `rock-mag-data.ts` | the linked panels and their data shaping |
| `test_rock_mag.py` | derived docs, results per specimen, units, tensor-derived values and axes, projected axes |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
