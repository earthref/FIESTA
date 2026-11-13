# GEOMAGIA

GEOMAGIA50 (https://geomagia.gfz.de) is the archeomagnetic, volcanic and sediment
paleomagnetic database of the past 50 ka, curated by Maxwell Brown. This node
hosts its **archeomagnetic and volcanic** records in FIESTA. The sediment database
(`ls_*` tables) is a later phase.

## Shape

| FIESTA | GEOMAGIA |
|---|---|
| contribution (one per study) | a `REFS` reference; the contribution ID is the GEOMAGIA reference ID |
| `sites` rows | its `ARCHEODIJ` records, one per `UID` (`site` = the UID) |

The node runs in data-source mode: GEOMAGIA's curators keep the catalogue, and
`configurations/sources/geomagia.py` mirrors it through `/v2/geomagia/source`
(docs/data-sources.md). Nobody uploads to it in FIESTA. `publish.web: false`
keeps it off production's SPA and portal until the GEOMAGIA team signs off.

## Data model (`data_models/3.4.json`)

Converted from the GEOMAGIA MySQL schema (`geomagia.sql`, `ARCHEODIJ` and `REFS`,
in the GEOMAGIA Django repository) rather than a legacy Meteor model. GEOMAGIA has
none. Column names are the `ARCHEODIJ` columns in lower case (each column's
`previous_columns` names its source), except:

- `lat` / `lon` (`SITE_LAT` / `SITE_LON`; FIESTA maps those names). Longitudes stay 0–360.
- `site`, the record's name, is the UID.
- Every code column (`material_id`, `pi_method_id`, `ac_id`, …) has a named column
  beside it (`materials`, `pi_methods`, `alteration_checks`, …). The named columns
  resolve the codes through the GEOMAGIA ID glossary. They are what the facets show
  and are validated against `controlled_vocabularies.json`.
- `region_country` and `continent` come from `SITE_ID`, and `archeo_volcanic` from the
  export's Archeo/Volcanic flag.

Units are GEOMAGIA's: ages in years CE, intensities in μT, dipole moments in 10²² Am².

**Missing values.** Measured numbers drop GEOMAGIA's missing-value markers (-1, -999,
-9999), as the GEOMAGIA site's own downloads do. Code columns keep -1 ("No
measurement") and 0 ("Not specified"), which have scientific meaning. A code that is
not in the glossary is written as `Unknown (ID n)` and fails validation, so it stays
visible. In the 2019 export these are 17 `DirMethID` values of 101/103 and two
`SpecTypeID` values of -1.

**VADM** is calculated from the intensity and site latitude, as the GEOMAGIA site
does, rather than taken from the stored column.

## Files

| File | From |
|---|---|
| `lookups.json` | all 38 tables of the GEOMAGIA ID glossary (https://geomagia.gfz.de/ID_glossary.php, Wayback copy of 2026-07-19; the live page's database was down) |
| `controlled_vocabularies.json` | the glossary tables the archeo/volcanic model uses, by name |
| `data_models/3.4.json` | `ARCHEODIJ` + `REFS` columns, labels from the GEOMAGIA site's own download headings |
| `seeds/` | six real references from the public CSV export, written by `sources/geomagia.py --out` |

## Data source

Until there is read access to the MySQL catalogue, the sync reads the public exports:

- the archeo/volcanic CSV on GEOMAGIA's logs page, `docs/geomagia50_v3_24072017_download.csv`.
  Its header says "Generated using GEOMAGIA50.v3.2 on May/22/2019": 9,434 records, 667
  references. It lacks the v3.4 additions (2020, 2021).
- the studies page (`studies.php`) for the references: authors, title, year, journal,
  DOI and MagIC link. A Wayback copy from 2023 covers 665 of the 667.

```bash
cd fiesta/backend
uv run python ../../configurations/sources/geomagia.py --csv <csv> --studies <studies.html> --out /tmp/geomagia   # files only
FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... uv run python ../../configurations/sources/geomagia.py \
  --api http://localhost:18000 --csv <csv> --studies <studies.html> --owner-email <steward> [--dry-run]
```

A local stack runs in `public` mode, which the sync skips; start it with
`FIESTA_CONTRIBUTIONS_MODE=public,geomagia=source` to try a sync. A scheduled run reads
`geomagia.csv` and `studies.html` from its `--state-dir` and the owner from
`--owner-map` (`default_owner`). `legacy.sync` stays off until the MySQL reader replaces
the CSV.

## Next

- Read the MySQL catalogue (SELECT-only account) instead of the CSV. That brings the
  current records, `AN_USE_STATUS_ID`, the radiocarbon and dendrochronology detail, edit
  history, and lookups straight from the source.
- A plugin for intensity, inclination and declination against age (GEOMAGIA's main
  figures). GEOMAGIA's field-model calculations stay in its own Django service for now.
- The sediment database.
