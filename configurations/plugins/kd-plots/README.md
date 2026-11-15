# `kd-plots` (KdD)

Partition-coefficient plots. The legacy KdD app had none; these are the
standard trace-element views of Kd data. A **Kd Plots** sub-tab on the
`levels` option's search levels plots every row matching the search (its
query, filters and the periodic-table picks); the contribution modal's
**Kd Plots** tab plots that contribution's rows. Three views:

| View | x | y | What it shows |
|---|---|---|---|
| Spider diagram | elements in a chosen order | log Kd | one line per pattern; orders: incompatible elements (Sun & McDonough 1989: Cs Rb Ba Th U Nb Ta K La Ce Pb Pr Sr P Nd Zr Hf Sm Eu Ti Gd Tb Dy Y Ho Er Tm Yb Lu), rare earth elements (La–Lu), or every element present by atomic number. It starts on the incompatible order when at least half the rows are in it, else on atomic number |
| Onuma diagram | ionic radius (Å), VI- or VIII-fold | log Kd | lattice-strain view (Onuma et al. 1968; Blundy & Wood 1994): the marker shape is the valence, and a pattern's elements of one valence are joined by a curve in radius order; element labels when ≤ 150 points |
| Kd by element | elements in the chosen order | log Kd | every row as a jittered point, with each element's median (geometric) as a black tick: the spread when a search holds too many patterns to read as lines |

A **pattern** is one contribution's rows that share the `pattern_columns`
(mineral, rock type, Kd definition, Kd types; case ignored). A pattern that
repeats an element is split into sets by occurrence. **Color by** chooses
any pattern column or the contribution. The three groups with the most
patterns take the categorical slots (blue, orange, aqua, as on every FIESTA
scatter plot) and the rest are a neutral "Other". The legend toggles each
group. Hovering a point highlights its pattern and names the row. Clicking
one in the search sub-tab opens its contribution.

**Plotted value.** A row's Kd. A row with only a range (most legacy KdD rows)
plots at the range's geometric mean (its middle on the log axis), or at its
one given end, as a hollow point. Error bars are Kd ± σ, else the range.
Rows without a positive Kd or range, or whose element is no symbol, are
counted in the notes under the plot. So are elements outside the chosen
order, and, on the Onuma diagram, elements without a radius.

**Ionic radii** (`kd-plots-elements.ts`) are Shannon (1976) effective radii
for each element's common valence in silicate systems: alkalis and Ag, Tl,
Cu as 1+; alkaline earths, Fe, Mn, Co, Ni, Zn, Cd, Pb, Hg as 2+; REE (Eu as
Eu³⁺, so an Eu²⁺ anomaly plots off the 3+ curve), Y, Sc, Al, Ga, In, Cr, V,
B, As, Sb, Bi as 3+; Ti, Zr, Hf, Th, U, Si, Ge, Sn as 4+; Nb, Ta, P as 5+; Mo
and W as 6+. The small cations have no VIII-fold radius. Volatiles, noble
gases, the platinum-group elements, Re and Au have none at either
coordination, so the Onuma diagram leaves them off.

No routes: the UI reads the rows through the core
`GET /v2/{node}/search/{table}/values` (the search's filters and the
visibility rules applied, up to 50,000 rows), so the plugin adds no data
path of its own.

Options (`plugins.kd-plots` in the node YAML; each column is checked against the data model):

| Option | Default | What |
|---|---|---|
| `table` | `kds` | the table of Kd rows |
| `levels` | `[Partition Coefficients]` | search levels (on `table`) that get the Kd Plots sub-tab |
| `element` | `element` | the element column (symbols) |
| `kd`, `kd_sigma`, `kd_low`, `kd_high` | same names | the Kd, its one-sigma uncertainty and its range |
| `pattern_columns` | `[minerals, rock_types, kd_definition, kd_types]` | with the contribution, what makes a pattern; each is a Color by choice |

| File | What |
|---|---|
| `plugin.py` | `KdPlotsPlugin`: options, their check, `frontend_config` (with the pattern columns' labels) |
| `index.tsx` | the sub-tab and the contribution tab |
| `kd-plots-view.tsx` | the three echarts plots, controls, legend and notes (a lazily loaded chunk) |
| `kd-plots-data.ts` | rows from the values route, plotted values, patterns, colour groups |
| `kd-plots-elements.ts` | atomic numbers, valences and Shannon radii; the element orders |
| `test_kd_plots.py` | options, the KdD activation, the option checks |
