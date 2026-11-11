# `plateau-calculations` (KArAr)

Python port of the legacy `PlateauCalculations` class: per-step ages from
⁴⁰Ar*/³⁹ArK via `t = (1/λ)·ln(1 + J·R)` (λ = 5.543e-10/yr, atmospheric
⁴⁰Ar/³⁶Ar = 295.5), cumulative ³⁹Ar release, plateau = lowest-MSWD run of ≥3
consecutive steps spanning ≥50% ³⁹Ar with MSWD ≤ 2.5.

`GET /v2/{node}/plugins/plateau-calculations/contributions/{id}/experiments/{name}/plateau`
returns the full age spectrum + plateau.

UI: an age-spectrum thumbnail on Experiments rows (the summary grid's `plot`
tile), opening the contribution modal's Age Spectra tab (every experiment's
spectrum and plateau).

Options (set in karar.yaml): `levels`, and λ, J and the three plateau
criteria — `default_lambda`, `default_j`, `min_plateau_steps`, `max_mswd`,
`min_ar39_percent`.

| File | What |
|---|---|
| `plugin.py` | `PlateauPlugin`: options, the age/plateau computation, the route |
| `index.tsx` | the UI module: the grid tile and the Age Spectra tab |
| `test_plateau_calculations.py` | deduplication, plateau selection, MSWD preference |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
