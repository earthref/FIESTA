# `field-models` (GEOMAGIA)

A **Field Models** sub-tab on the base level (GEOMAGIA: Sites) with the
GEOMAGIA site's field-model pages: predicted geomagnetic field curves from
published spherical-harmonic models at a chosen location or at the current
search's site locations, with the search's measurements overlaid, uncertainty
bands, ensembles, global Mollweide maps with a year-slider movie, and the
exports. It follows the sidebar's filters like the other sub-tabs.

## What it does (GEOMAGIA parity)

- **Models**: GEOMAGIA's catalogue (field_models/catalog.py), grouped by dataset
  as it groups them (legacy models folded away), each labelled
  "name — author et al. (year)" with its citation, DOI, terms and source in the
  picker's tooltip, under the plots and in every export. Models with an
  uncertainty array or an ensemble are marked ±.
- **Locations**: a manual latitude, longitude (−180..360) and altitude
  (−1..100 km), or the search's distinct site locations, separately those with
  an intensity (ba ≥ 0) and those with a declination or inclination, at sea
  level; "Use median search locations" calculates one median location per
  group, longitude unwrapped across the largest gap (field_models/database.py).
- **Years**: start, end and step (≥ 1), defaulting to the search's age filter,
  else −1000..1990 every 10. Each curve keeps only its model's interval (no
  extrapolation); a model outside the window is an error. Limits: 4,001
  points per curve, 1,000 curves and 500,000 values per request, 2,000,000
  ensemble member values (GEOMAGIA's messages).
- **Curves** (echarts): intensity or VADM, declination, inclination or ΔI
  (I − atan2(2 sin φ, cos φ)) against year; ±1σ bands from the file's
  uncertainty array (propagated as SHMODEL/ERRFDZ do) or, for models with an
  ensemble, the members' sample SD (ddof=1, declination about its circular
  mean); the ensemble members themselves; the search's measurements coloured by
  region with age and intensity/VADM error bars and GEOMAGIA's hover fields;
  legend toggles; zoom; PNG per plot; the global map's year as a cursor.
- **Global field**: the model's 37 × 72 grid at 5° (surface F, D, I or ΔI;
  core-mantle-boundary Br at 3480 km; secular acceleration of surface F and of
  CMB Br from the spline's analytic second derivative) on a Mollweide map with
  contours, coastlines, graticule, the search's sites, colour limits, a probe,
  a year slider with play/pause and frame speed, PNG, and an animated GIF of
  every year.
- **Exports**: "Download model data" is GEOMAGIA's zip: per model (and per
  intensity/direction group for search locations) a `.txt` with
  `# AGE SITE_LAT SITE_LON INCL DECL INT EI ED EF`, its ΔI companion,
  `locations.tsv`, every ensemble member when shown, `parameters.json` and a
  README with the citations. "Download graphs" zips intensity, VADM,
  declination and inclination/ΔI PNGs at 3600 px.

## The engine (`shmodel.py`)

A numpy port of the Fortran GEOMAGIA runs: SHMODEL, INTERV, BSPLINE, COORDS,
PLMBAR, MAGFDZBR and ERRFDZ (models/anymodel.f; the same routines as GFZ's
public CALS10kfield.f) and the request driver's global grid, spline
derivatives and synthesis bases (field_models/fortran/intensity.f90): cubic
B-splines in time, Schmidt semi-normalised Legendre functions to degree 20,
geodetic → geocentric coordinates, a = 6371.2 km, keeping the Fortran's
single-precision literals. Ensembles follow ensembles.py: members' X/Y/Z at
their epochs through the synthesis bases, then the natural cubic in time.

**Agreement with the Fortran** (2026-11-14): GEOMAGIA's intensity.f90 +
anymodel.f SHMODEL and a full-precision driver around GFZ's CALS10kfield.f
routines, compiled with gfortran 15.2 (`-O2 -std=legacy`) in a throwaway
container, on 12 public models (CALS10k.2, gufm1, LSMOD.2, CALS10k.1b,
CALS3k.4b, CALS7K.2 and the converted SHA.DIF.14k, SHAWQ2k, GGFSS70, pfm9k.2,
pfm9k.1a, ARCH3k.1; 8 sites incl. both poles, 2 altitudes, ~160 epochs each,
the global grid at 3 epochs, the bases): largest relative difference 1.6e-11
(F, D, I, their uncertainties, Br, accelerations), largest absolute 1.3e-10°
(inclination near a pole). The tests assert 1e-9 against reference numbers
from that build for a synthetic degree-3 model and for CALS10k.2.

The conversions (convert.py, GEOMAGIA's conversion.py semantics) produce files
**byte-identical** to GEOMAGIA's own converted copies (sha256 equal to the
`output_sha256` in its conversion manifest) for SHA.DIF.14k, SHAWQ2k,
SHAWQ-Iron Age, GGFSS70, pfm9k.2, ArchKalmag8k, ArchKalmag14k and HistKalmag,
and the ensemble cubes of pfm9k.2, ArchKalmag8k, ArchKalmag14k and HistKalmag
equal GEOMAGIA's (`ensemble_manifest.json` sha256).

## The models: public sources only (`models.yaml`, `fetch_models.py`)

No coefficient file is in this repository. `models.yaml` pins each model's
public source (URL at a commit/version where it has one, expected sha256,
format, converter, citation, terms as stated at the source);
`fetch_models.py` downloads, checks, converts and writes them to the node's
storage under `storage_prefix` (`<prefix>field-models/models/*.txt`,
`ensembles/*.npy`, `catalog.json` last). The plugin reads them from there,
parsed models cached in memory and ensembles as verified, memory-mapped copies
in the temp directory.

| Model | Source | Terms at the source | Uncertainty |
|---|---|---|---|
| ArchKalmag8k, ArchKalmag14k, HistKalmag | University of Potsdam Kalmag service (MEAN and ENS, 256 draws; one request each per run, cached) | none stated | ensemble (256) |
| SHA.DIF.14k | EarthRef ERDA 1897 (RAR) | none stated | — |
| SHAWQ2k, SHAWQ-Iron Age | EarthRef ERDA 2453 (RAR, Excel) | none stated | — |
| GGFSS70 | EarthRef ERDA 2472 (spline in ka BP → 1950 − 1000·ka) | none stated | — |
| pfm9k.2 | EarthRef ERDA 2522 (mean + 100 samples) | none stated | ensemble (100) |
| pfm9k.1a | EarthRef ERDA 1951 | none stated | — |
| CALS10k.2 | GFZ CALS10k2.zip | none stated | — |
| LSMOD.2, ARCH10k.1, HFM.OL1.A1, GUFM.1 (gufm1) | GFZ pymagglobal at commit e9b87bb | CC0-1.0 (`.license` sidecars) | — |
| CALS10K.1b, CALS7K.2, CALS3K.3, CALS3K_cst.1, ARCH3K.1, ARCH3K_cst.1, SED3K.1, CALS3K.4e | GFZ Nextcloud share linked from pymagglobal (its zip is generated per download, so members are pinned) | none stated | file (CALS10K.1b, CALS3K.4e) |

CALS3K.4e is GFZ's `CALS3k.4b`: Korte & Constable (2011)'s bootstrap-average
model, the only CALS3k.4 variant with an uncertainty array; degree 10, 402
splines, mean + error layout as GEOMAGIA's catalogue requires, and 2,519,166
bytes against GEOMAGIA's 2,519,156. ARCH3K.1's public file has no uncertainty
array (GEOMAGIA's copy has one), so it has no band here.

**Not available: no public source** (in GEOMAGIA's catalogue, listed under
the picker; add them to models.yaml once published): ARCH-UK.1 (Batt et al.
2017), ARCH3K.1e and SED3K.1e (error-array variants), CALS3K.3e (CALS3k.3 plus
an uncertainty array; GFZ's CALS3k.3b is a different bootstrap model, so it is
not substituted), BIGMUDI4k.1 (its only host, cobs.zamg.ac.at, refused
connections on 2026-11-14).

### Fetching

From `fiesta/backend`, with the deployment's settings (S3 credentials) in the
environment, as for the API:

```bash
FIESTA_CONFIG_FILE=../../configurations/fiesta.yaml uv run python \
    ../../configurations/plugins/field-models/fetch_models.py --node geomagia --upload
```

RAR archives need `bsdtar` (Debian/Ubuntu `libarchive-tools`); without it
SHA.DIF.14k and the SHAWQ models are skipped and reported. Downloads go to
`./field-models-cache` (`--cache`), so re-runs reuse them. `--out DIR` also
writes the files locally and `--publish DIR` uploads such a directory without
downloading (convert where bsdtar is, upload where the credentials are);
`--only NAME` refreshes one model; `--record` prints observed sha256s instead
of enforcing the pins (for a new version: update models.yaml from its output).
About 310 MB are downloaded and 360 MB stored (ArchKalmag14k's ensemble cube
is 252 MB).

## Options (`plugins.field-models`)

| Option | Default | |
|---|---|---|
| `base_level` / `table` | `Sites` / `sites` | the level the sub-tab joins and its table |
| `columns` | lat, lon, age, age_min, age_max, ba, sigma_ba, vadm, sigma_vadm, decl, incl, region_country, site_name, uid, age_error_type, num_sigmas | the overlaid measurements' columns (hover and colour by region) |
| `default_models` | `[CALS10k.2]` | selected when the view opens |
| `default_latitude`, `default_longitude`, `default_start_year`, `default_end_year`, `default_step` | 50, 10, −1000, 1990, 10 | GEOMAGIA's defaults |
| `storage_prefix` | `field-models/` | where fetch_models.py writes in the node's storage |

## Routes (`/v2/{node}/plugins/field-models/...`)

| Method | Path | |
|---|---|---|
| GET | `/catalog` | installed models (grouped), intervals, uncertainty, ensembles, citations, terms; the unavailable list; limits |
| POST | `/curves` | `{models, location_source: manual\|database, latitude, longitude, altitude, sites: [[lat, lon, ba, decl, incl]…], use_median, start_year, end_year, step}` → GEOMAGIA's curve result (series of F, D, I, VADM and file uncertainties per model and location; location counts, medians, site groups) |
| POST | `/ensembles` | the same body (+ `include_members`) → ensemble SDs (and members) for the chosen models with ensembles |
| GET | `/global?model=&year=` | the 37 × 72 grid at one year |

## Files

`plugin.py` (options, model store, routes), `shmodel.py` (engine),
`convert.py` (source formats → B-splines), `fetch_models.py` + `models.yaml`
(sources), `index.tsx`, `field-models-view.tsx`, `field-models-charts.ts`,
`field-models-data.ts` (exports, zip), `global-maps.tsx`, `global-field.ts`
(Mollweide, contours), `gif.ts` (GIF encoder), `coastlines.ts` (Natural Earth
1:110m, public domain), `test_field_models.py`.
