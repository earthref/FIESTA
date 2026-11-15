# geomag-series

Geomagnetic field records against age: the **Plots** sub-tab of a search level
of dated field records, and the query refinements of the GEOMAGIA site's search
page as sidebar filters. Activated by GEOMAGIA (`configurations/geomagia.yaml`,
on its Sites level); any node with dated intensities or directions can use it.
Ported from the GEOMAGIA Django site (private `maxwellbrown/geomagia`:
`search/plot_data.py`, `static/search/results-plots.js`, `search/refinements.py`,
`search/radius.py`, `search/views.py`), 2026-11-14.

## The Plots sub-tab

A `records` sub-tab (`fiesta/frontend/src/plugins/index.tsx`): it draws the
level's own matches, so every sidebar filter, the Geospatial area, the grid's
column filters and the with/without data filter apply as they do on Summaries,
and its count is the level's. Rows come from
`GET /search/{table}/values` with the level search's params (`searchParams`).

- Three stacked plots against age (`age_label`, "Age (BCE − / CE +)"):
  intensity, with an Intensity / VADM toggle and its y error bars (σ, or the
  VADM's); declination, drawn −180..180 (the site's `signed_declination`);
  inclination. Every point has the age's error bars: `age_minus` below,
  `age_plus` above. As the site, records without a known age are left out (and
  counted), and so are records with none of the three.
- VADM = B·10·R³/10²²/√(1+3 sin²φ), R = 6 371 200 m, at the record's own
  latitude (no relocation), computed in the browser unless `vadm` names a column.
- Colour by `color_id` with the site's region formula, hsl(id·137.508 mod 360,
  65 %, 38 + (id mod 3)·6 %), grey `#718096` for none; the legend lists
  `color_label`. Without `color_id` every point is the node colour.
- Hover: age, value (and its error), α95 for directions, region, age error,
  age error type with its sigmas, then the `hover` columns (GEOMAGIA: site,
  locality, citation, UID). Click a point to open its contribution.
- Zoom: drag a box, or the wheel in box-zoom or pan mode. The three plots share
  the age window (EChart `xView` / `onXView`), which survives redraws (a new
  search, the Intensity/VADM toggle); "Show every age" or any plot's reset
  returns to the full range.
- Export: each plot's camera button saves `<export_name>_<plot>_<time>.zip`
  (its PNG and `params.txt`); Download Graphs saves
  `<export_name>_graphs_<time>.zip` (intensity, VADM, declination and
  inclination PNGs and `params.txt`). PNGs are publication figures as the
  site's: 1200 px at 3× (3600 px wide), white, titled `<node key> — <plot>`, the
  regions' legend below, over the age window shown. `params.txt` is JSON: the
  node, level, page URL and the search's request params, and the counts.

## Refinements

| GEOMAGIA refinement | FIESTA | How |
|---|---|---|
| Data type (intensity / direction / all) | facet `data_type` | derived: "Intensity" (intensity > 0), "Direction" (a declination or inclination); both picked or none = all |
| Archeomagnetic / volcanic | facet `archeo_volcanic` | node YAML, a data-model column |
| Age min / max | range `summary._num.age` | node YAML |
| Continent, region / country | facets | node YAML |
| Map viewport | the Geospatial filter | core |
| Site name (contains, any case) | sidebar Site Name | this plugin's filter; the core `<column>:"*text*"` wildcard token; suggests up to 30 names in the search |
| Radius (centre + km, default 500, ≤ π·6371) | sidebar Radius Search | this plugin's filter; the core `radius:"<lat>,<lon>,<km>"` token (great-circle, OpenSearch arc distance) |
| Materials, dating methods | facets | node YAML |
| PI method families ("All X methods") | facet `pi_family` | derived from `pi_methods` codes by `pi_families` (GEOMAGIA's codes in its YAML; code 27 is in Microwave and Walton, as the site lists it) |
| PI methods (each) | facet `pi_methods` | node YAML |
| Alteration monitoring | facet `alteration_checks` | node YAML |
| MD checks yes / no | facet `md_check` | derived (`checks`): Yes = a code ≥ 1, No = every code −1 or 0, blank = neither |
| Cooling rate yes / no | facet `cooling_rate_check` | derived, as MD checks |
| Anisotropy (use status) | facet `anisotropy_use_status` | node YAML |
| Minimum PI specimens | range `summary._num.num_acc_spec` (minimum) | node YAML |
| Maximum σBa | range `summary._num.sigma_ba` (maximum) | node YAML (blank σ is no value, so 0 < σ as the site) |
| Minimum direction specimens or samples | range `summary._num.direction_n` (minimum) | derived: the greatest of `direction_counts` |
| Maximum α95 | range `summary._num.alpha_95` (maximum) | node YAML |
| Maximum age error | range `summary._num.age_error` (maximum) | derived: max(age_min, age_max) for a dated record with both ≥ 0 |

Facets are multi-select (values OR'd) where the site's selects pick one, a
superset of its behaviour. The derived columns are the plugin API's
`derived_columns` / `derive_values` (docs/plugins.md): indexed with each record
doc (and unioned into its contribution's), so a node needs a `fiesta rebuild`
after activating the plugin or changing these options.

## Options (`plugins.geomag-series`)

`base_level` (the level the Plots tab is on; unset: none); `age`, `age_minus`,
`age_plus`, `age_error_type`, `age_sigmas`, `age_label`, `age_unit`;
`intensity`, `intensity_error`, `intensity_unit`; `vadm`, `vadm_error` (unset:
computed); `declination`, `inclination`, `alpha95`, `latitude`; `color_id`,
`color_label`; `hover` (columns or `summary.<block>.<name>` paths);
`export_name`; `name_search` (+ `name_search_label`); `radius_search`;
`pi_methods` + `pi_families` (`{name, codes}`); `checks` (`{derived name: code
column}`); `direction_counts`. `check()` refuses a base level that is not a
search level, a plotted column that is not a number column of its table, other
columns not in it, and derived names that are data-model columns.

## Decisions (left out on purpose)

- **The 58-column CSV export** (`search/exports.py`): FIESTA's Download Results
  and contribution downloads are the node's exports; a GEOMAGIA-shaped CSV is a
  node export to add if the GEOMAGIA team asks for it.
- **Saved searches, params.txt upload and the signed search → models cookie**:
  a FIESTA search is its URL (`params.txt` carries it), so a link restores a
  search; the Field Models tab follows the sidebar's filters directly.
- **Publication mode** (reference ids / authors): FIESTA's contribution-level
  search (Contributions tab, contributor and DOI filters, free text) covers it.
- **The radius outline on the map**: the Map tab shows the matching records,
  not the circle.
- **Declination and inclination error bars**: the site computes them but does
  not draw them; neither do we (α95 is in the tooltip).
- **Y zoom is per plot**: only the age axis is shared, as only it is common.

## Files

`plugin.py` (options, check, derived refinements, facets for the name and
radius searches) · `index.tsx` (sub-tab and sidebar filters) ·
`geomag-series-view.tsx` (plots, legend, PNG export) ·
`geomag-series-data.ts` (records, VADM, colours, zip, params.txt) ·
`geomag-series-filters.tsx` (Site Name and Radius Search) ·
`test_geomag_series.py`.
