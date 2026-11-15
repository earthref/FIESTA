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
and the model only changes when its columns do. 1.0 was edited in place twice before
any GEOMAGIA data was imported beyond a local stack: on 2026-11-13 (`anisotropy_use_status`
added) and on 2026-11-14, when its GEOMAGIA lookup codes and relational keys were
replaced by names (below).

Converted from the GEOMAGIA MySQL schema (`geomagia.sql`, `ARCHEODIJ` and `REFS`,
in the GEOMAGIA Django repository) rather than a legacy Meteor model. GEOMAGIA has
none. Column names are the `ARCHEODIJ` columns in lower case (each column's
`previous_columns` names its source), except:

- `lat` / `lon` (`SITE_LAT` / `SITE_LON`; FIESTA maps those names). Longitudes are
  0–360: records uploaded since 2019 store -180–180 in the database, and the sync adds
  360 to a negative one.
- `site`, the record's name, is the UID.
- **Names, not keys.** The model carries no GEOMAGIA relational key but the record's
  `uid` (and the contribution's `geomagia_reference_id`, which is its contribution ID).
  Each lookup code column is replaced by a named column: `MATERIAL_ID` → `materials`,
  `SPECIMEN_TYPE_ID` → `specimen_types`, `AGE_ERROR_TYPE_ID` → `age_error_type`,
  `DATING_METHOD_ID` → `dating_methods`, `PI_METHOD_ID` → `pi_methods`, `AC_ID` →
  `alteration_checks`, `MD_CK_ID` → `md_checks`, `AN_CORR_SET_ID` →
  `anisotropy_corrections`, `AN_USE_STATUS_ID` → `anisotropy_use_status`,
  `CR_CORR_SET_ID` → `cooling_rate_corrections`, `DM_METHOD_ID` → `demag_method`,
  `DM_ANALYSIS_ID` → `dir_analysis`, the four radiocarbon calibration software / dataset
  codes → `c14_calib_software`, `c14_calib_dataset`, `calc_c14_calib_software`,
  `calc_c14_calib_dataset`, and `COMP_REF` → `compilations`. The sync resolves codes
  through the source's lookups (the database's lookup tables, or the GEOMAGIA ID
  glossary for the CSV). Every named column has a `cv("…")` validation against
  `controlled_vocabularies.json`, which lists both sets of names where they differ (the
  database renamed a few, e.g. "TRM tensor" is now "ATRM"). A FIESTA upload, were the
  node ever in public mode, writes these names, never codes.
- `region_country` and `continent` come from `SITE_ID` (the database's `aa_locations`,
  as the GEOMAGIA site reads it, or the glossary's 118 regions for the CSV).
- `see_also` / `see_also_doi` come from `CROSS_REF_ID` (the "see also" references,
  `:`-separated `REFS` IDs): the cited references' short citations, and the DOIs of
  those that have one (a `:` inside a DOI is written `%3A`, as in a DOI URL, since `:`
  separates list items). `superseded_by` / `superseded_by_doi` come from `SUPERSEEDED`,
  the `REFS` ID of the publication whose data supersede the record (0 and -1: none; in
  the dump, the 27 records of reference 116 are superseded by 537). `cross_uid`
  (companion records) stays as UIDs. `C14_ID` and `DENDRO_ID`, keys into
  `aa_14c_dates` and the dendrochronology table, which the sync does not read, are left
  out. The CSV has no cross references, so those columns stay blank from it.
- `archeo_volcanic` is "Volcanic" when `MATERIAL_ID` includes lava, volcanic ash,
  other volcanic, obsidian, granite or volcanic glass (codes 4, 25, 41, 47, 51, 52), as
  the GEOMAGIA site classifies records; the CSV's own flag follows the same rule.
- `anisotropy_use_status` (`AN_USE_STATUS_ID`, the `measurement_use_status` table: not
  specified, correction applied, assessment only) comes only from the database; the
  2019 CSV predates it.

Units are GEOMAGIA's: ages in years CE, intensities in μT, dipole moments in 10²² Am².

**Missing values.** Measured numbers drop GEOMAGIA's missing-value markers, as the
GEOMAGIA site's own downloads do: -999/-9999 (the CSV); -1; 0 in counts, intensities,
alpha95, k and the AF/thermal steps; 999 in declination and inclination; 9999 in
radiocarbon ages; -50000 (unknown) in ages; "0" in sample and site names. Lookup codes
-1 and 0 have scientific meaning and are written as their names, "No measurement" and
"Not specified". A code with no lookup entry is written `Unknown` and fails
validation, so it stays visible: in the database these are 311 records whose
`specimen_types` and 249 whose `materials` are `Unknown` (code -1), all uploaded in
2019–2020. (The 2019 CSV's 17 `Unknown` `demag_method`s, codes 101/103, have since been
corrected to 1 and 3.)

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
- Code columns are `SET`s, read as `"101,102"` and written as their names, `:` separated.
- Some SICI DOIs in `REFS` hold `<…>` ("…97<829:DRHLFU>2.0.CO;2"); only real tags are
  stripped, so they survive.
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
