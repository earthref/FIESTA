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

## Data model (`data_models/1.0.json`)

The version is FIESTA's own numbering of this model, not GEOMAGIA50's release
number (v3.2 for the public CSV, v3.4 for the catalogue): a release adds records,
and the model only changes when its columns do. (`an_use_status_id` and
`anisotropy_use_status` were added to 1.0 on 2026-11-13, before any GEOMAGIA data was
imported.)

Converted from the GEOMAGIA MySQL schema (`geomagia.sql`, `ARCHEODIJ` and `REFS`,
in the GEOMAGIA Django repository) rather than a legacy Meteor model. GEOMAGIA has
none. Column names are the `ARCHEODIJ` columns in lower case (each column's
`previous_columns` names its source), except:

- `lat` / `lon` (`SITE_LAT` / `SITE_LON`; FIESTA maps those names). Longitudes are
  0–360: records uploaded since 2019 store -180–180 in the database, and the sync adds
  360 to a negative one.
- `site`, the record's name, is the UID.
- Every code column (`material_id`, `pi_method_id`, `ac_id`, …) has a named column
  beside it (`materials`, `pi_methods`, `alteration_checks`, …). The named columns
  resolve the codes through the source's lookups: the database's lookup tables, or the
  GEOMAGIA ID glossary for the CSV. They are what the facets show and are validated
  against `controlled_vocabularies.json`, which lists both sets of names where they
  differ (the database renamed a few, e.g. "TRM tensor" is now "ATRM").
- `region_country` and `continent` come from `SITE_ID` (the database's `aa_locations`,
  as the GEOMAGIA site reads it, or the glossary's 118 regions for the CSV).
- `archeo_volcanic` is "Volcanic" when `MATERIAL_ID` includes lava, volcanic ash,
  other volcanic, obsidian, granite or volcanic glass (codes 4, 25, 41, 47, 51, 52), as
  the GEOMAGIA site classifies records; the CSV's own flag follows the same rule.
- `an_use_status_id` / `anisotropy_use_status` (`AN_USE_STATUS_ID`, the
  `measurement_use_status` table: 0 not specified, 1 correction applied, 2 assessment
  only) come only from the database; the 2019 CSV predates them.

Units are GEOMAGIA's: ages in years CE, intensities in μT, dipole moments in 10²² Am².

**Missing values.** Measured numbers drop GEOMAGIA's missing-value markers, as the
GEOMAGIA site's own downloads do: -999/-9999 (the CSV); -1; 0 in counts, intensities,
alpha95, k and the AF/thermal steps; 999 in declination and inclination; 9999 in
radiocarbon ages; -50000 (unknown) in ages; "0" in sample and site names. Code columns
keep -1 ("No measurement") and 0 ("Not specified"), which have scientific meaning. A
code with no lookup entry is written as `Unknown (ID n)` and fails validation, so it
stays visible: in the database these are `SPECIMEN_TYPE_ID` -1 (311 records) and
`MATERIAL_ID` -1 (249), all uploaded in 2019–2020. (The 2019 CSV's `DirMethID`
101/103 have since been corrected to 1 and 3.)

**VADM** is calculated from the intensity and site latitude, as the GEOMAGIA site
does, rather than taken from the stored column.

## Files

| File | From |
|---|---|
| `lookups.json` | all 38 tables of the GEOMAGIA ID glossary (https://geomagia.gfz.de/ID_glossary.php, Wayback copy of 2026-07-19; the live page's database was down); the CSV path's lookups |
| `controlled_vocabularies.json` | the lookup names the archeo/volcanic model uses: the glossary's and the database's |
| `data_models/1.0.json` | `ARCHEODIJ` + `REFS` columns, labels from the GEOMAGIA site's own download headings |
| `seeds/` | six real references from the public CSV export, written by `sources/geomagia.py --out` |

## Data source

`configurations/sources/geomagia.py` reads one of two sources (`--source auto|mysql|csv`;
`auto` picks MySQL when `GEOMAGIA_MYSQL_HOST` is set and `--csv` is not given). Both
produce the same contributions (columns, missing values, VADM, citations); the database
fills more columns and has the current records.

**The MySQL catalogue** (`ARCHEODIJ`, `REFS`, the lookup tables, `uploader` names,
`aa_locations`, and `archeodij_edit_history` for dates): SELECT statements in a READ
ONLY transaction. The connection is `GEOMAGIA_MYSQL_HOST`, `GEOMAGIA_MYSQL_PORT` (3306),
`GEOMAGIA_MYSQL_USER`, `GEOMAGIA_MYSQL_PASSWORD`, `GEOMAGIA_MYSQL_DATABASE` (geomagia),
from the scheduled run's `/etc/fiesta/source-geomagia.env`. A contribution is dated by
its records: created at the earliest upload month, revised at the latest upload, edit
or edit-history date, so an unchanged reference is skipped on the next run. Notes from
Max Brown's full dump (MySQL 8.4, 72 tables, 12,529 records in 858 references):

- Table names are lower case (`archeodij`, `refs`) while the Django app names
  `ARCHEODIJ`; on Linux (`lower_case_table_names=0`) only one spelling works, so the
  reader looks names up in `information_schema`.
- The tables are latin1 (the four newer ones utf8mb4). The reader connects as utf8mb4
  so the server converts; `REFS`, `uploader` and some lookup names hold HTML entities
  and `<sup>` tags, which it strips.
- Code columns are `SET`s, read as `"101,102"` and written `101:102`.
- `uploader.SHORT_NAME` holds email addresses; the reader selects only `ID` and `NAME`.

**The public CSV**, the fallback when there is no database access:

- the archeo/volcanic CSV on GEOMAGIA's logs page, `docs/geomagia50_v3_24072017_download.csv`.
  Its header says "Generated using GEOMAGIA50.v3.2 on May/22/2019": 9,434 records, 667
  references. It lacks the 2019–2020 additions.
- the studies page (`studies.php`) for the references: authors, title, year, journal,
  DOI and MagIC link. A Wayback copy from 2023 covers 665 of the 667 (274 and 487 have
  since been deleted from GEOMAGIA).

A database that cannot be read fails the run instead of falling back to the CSV, and once
a node has synced from the database, do not sync it from the CSV again: the 2019 records
would replace newer ones.

```bash
cd fiesta/backend
GEOMAGIA_MYSQL_HOST=... GEOMAGIA_MYSQL_USER=... GEOMAGIA_MYSQL_PASSWORD=... \
  uv run python ../../configurations/sources/geomagia.py --out /tmp/geomagia            # files only
uv run python ../../configurations/sources/geomagia.py --csv <csv> --studies <studies.html> --out /tmp/geomagia
FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... uv run python ../../configurations/sources/geomagia.py \
  --api http://localhost:18000 --owner-email <steward> [--dry-run]                     # + GEOMAGIA_MYSQL_* or --csv
```

A local stack runs in `public` mode, which the sync skips; start it with
`FIESTA_CONTRIBUTIONS_MODE=public,geomagia=source` to try a sync. A scheduled run reads
the database when its env file sets `GEOMAGIA_MYSQL_HOST`, else `geomagia.csv` and
`studies.html` from its `--state-dir`, and the owner from `--owner-map`
(`default_owner`). `legacy.sync` stays off until the SELECT-only account exists.

## Next

- The database's other tables: radiocarbon dates (`aa_14c_dates`), the edit history as
  record history, `geomagnetic_models` (30 field models: citation, period, data used)
  and `journal_list` (130 curated journal names, a cleaner `journal`).
- A plugin for intensity, inclination and declination against age (GEOMAGIA's main
  figures). GEOMAGIA's field-model calculations stay in its own Django service for now.
- The sediment database.
