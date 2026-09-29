# The ERDA node

The EarthRef.org Digital Archive is a general-purpose repository for "any type
of digital data object associated with the Earth sciences" — spreadsheets,
diagrams, posters, maps, videos, programs, lesson plans. The legacy site
(https://earthref.org/ERDA/) is a Perl CGI app over the classic `er_*` schema;
this node ports its record model and search surface onto FIESTA.

What makes ERDA different from the other nodes: its unit of publication is a
**described file**, not a table of measurements. The science metadata that
MagIC/CDR/KArAr carry per specimen (geologic class, lithology, method codes)
is replaced here by discovery metadata — what the object is, who it is pitched
at, what it covers geographically and in geological time, and who owns it.

## Data model 1.0

Three tables, hierarchy `contribution → objects → files`:

| Table | Grain | Notes |
|---|---|---|
| `contribution` | The citable, versioned unit | Standard FIESTA workflow columns. `reference` is `recommended()`, not `required()` — ERDA exists to archive *unpublished* material. |
| `objects` | One archived digital object = one legacy ERDA record | Everything the legacy "Detailed File Information" page shows, plus the fields its Advanced Search scopes queries to. |
| `files` | One row per file | A single-file object has one row; a bundle (a zip, an image series) has one per file. References its object by `object`. |

`objects` columns are grouped: **Names**, **Description**, **Software**,
**Provenance**, **Rights**, **Geography**, **Geologic Age**.

Long-form fields (`description`, `instructions`, `copyright_description`)
use column type `Text`. It is listed as a valid type in
`fiesta/domain/data_model.py` but ERDA is the first model to use it; it
behaves exactly as `String` everywhere in the code today, and marks the
fields a future editor should render as a textarea rather than an input.

### Mapping from the legacy record

| Legacy ERDA | Data model 1.0 |
|---|---|
| File Name | `files.file` (+ `files.size_bytes`, `files.media_type`, `files.format`) |
| Data Type | `objects.data_types` — `cv("data_type")`, the 38-term legacy dropdown |
| Expert Level | `objects.expert_level` — `cv("expert_level")`, the 9 legacy levels, each carrying a `position` so "this level and higher/below" stays orderable |
| Computer Program | `objects.computer_program` + `computer_program_version` |
| Contributor | `contribution.contributor` (workflow metadata, written on activation) |
| Source / Source Web Site | `objects.citations` + `objects.source_url` |
| Description / Instructions | `objects.description` / `objects.instructions` |
| Keywords, Parameters, Materials, Samples, Techniques | the same five `List` columns on `objects` (`techniques` added 2026-09-28 for the legacy import) |
| Location | `objects.continents_oceans`, `countries`, `state_provinces`, `regions`, `oceans_seas`, `locations` (free text), `lat`/`lon`, `lat_s`/`lat_n`/`lon_w`/`lon_e` |
| Geological Age Range and Timescale | `objects.age_high`/`age_low`/`age_unit` + `timescale_eon`…`timescale_stage` |
| Project (group ⇒ project ⇒ web site) | `objects.project`, `project_group`, `project_url` |
| Resource Matrix (ERESE) | `objects.education_topics` |
| Copyright Owner / Web Site / Description | the same three columns on `objects` |
| Persistent Link, Direct Download Link | derived from the contribution ID; not stored |

Two additions the legacy record has no slot for: `objects.license`
(`cv("license")`) and `objects.external_url`, which gives the `web link` data
type — an ERDA record that archives a link rather than a file — somewhere to
put the link.

**Longitudes here are −180/180**, matching the legacy Advanced Search, *not*
MagIC's 0–360 convention.

## Vocabularies

`config/erda/controlled_vocabularies.json` — `data_type`, `expert_level`,
`project_group`, `license`, `erda_version`, `boolean`, plus `age_unit`,
`continent_ocean`, `country`, `ocean_sea`, `state_province`, and the five
`timescale_*` vocabularies shared with MagIC (copied, not referenced, so a
node stays fully described by its own config).

`config/erda/suggested_vocabularies.json` — `projects` (the 42 legacy projects,
each tagged with its group), `education_topics`, `computer_programs`,
`file_formats`, `region`. Suggested-vocabulary misses are warnings, which is
what an open-ended archive needs.

## Search

Levels: **Contributions**, **Digital Objects**, **Files**. Facets:
`data_types`, `expert_level`, `education_topics`, `project`, `project_group`,
`continents_oceans`, `countries`, `timescale_period` — the legacy Advanced
Search dropdowns plus the geographic and timescale terms its `term_type`
selector scoped queries to.

Result cards come from the `record-cards` plugin (see plugins.md), laid out
by `plugins.record-cards.cards` in erda.yaml (one card per search table,
editable in the admin UI's Plugins tab); without it the default MagIC-shaped
card would render nothing but "No … Data".

## Known gaps

- **Age-range search.** `age_high`/`age_low` are `Number` columns, but the
  shared index mapping types every cell as text (`numeric_detection: false`),
  so a `range` filter on them would compare lexically. Numeric age-range
  search needs an explicit mapping for these fields in
  `fiesta/search/index.py` — a core change, deliberately not made here.
- **Object bytes.** The data model describes the files; the legacy import
  stores each object's files as the revision's non-canonical files, but
  serving per-object downloads (rather than the canonical contribution file)
  is still a storage/API concern, not a data-model one.

## Legacy import

`fiesta legacy-inventory erda --out ../migration/erda` (run through
`make fiesta ENV_FILE=… NODE=erda`), driven by the `legacy:` block in
`erda.yaml` (`kind: earthref-cgi`, `fiesta/services/legacy_cgi.py`), writes an
inventory that `fiesta sync-legacy` accepts. It is read-only against the legacy
side.

**Source.** No structured source is reachable from FIESTA's credentials: the
`fiesta` role on the legacy OpenSearch cluster reads only `er_users` (every
other index name, including `erda` and `er_*`, answers 403) and the FIESTA
Postgres has no `er_*` tables. So the reader crawls the public record pages
`earthref.org/ERDA/<id>/` for ids 1–`max_id` (4900) and downloads each file
through the page's `z-download.cgi` links (a single-file record's
`download:<id>/` link redirects to its file). Everything is cached under the
output directory (`pages/`, `files/`), so a re-run resumes. As of 2026-09-28:
**2,569 live records, ids 1–2783** (sparse; nothing above 2783), 3,983 files.

**Mapping.** One contribution per record, with the legacy id as the
contribution id, published and latest; one `objects` row (object = the legacy
id) and one `files` row per file (with its real size); the files are the
revision's attachments next to `erda_contribution_<id>.txt`. Details:

- The pages carry **no dates**, so `created_at`/`activated_at` are the time the
  page was first seen live (kept in `pages/index.json`, stable across re-runs).
- **Location** `DMS [- DMS] ▪ DMS [- DMS], term, …` gives `lat`/`lon` or the
  `lat_s`/`lat_n`/`lon_w`/`lon_e` box; each term goes to the first of
  `continents_oceans`, `oceans_seas`, `countries`, `state_provinces`,
  `regions` whose vocabulary knows it, else to `locations`.
- **Geological Age** `high - low unit, name, …`: numbers to
  `age_high`/`age_low`/`age_unit`, names to the timescale column whose
  vocabulary knows them.
- **Source**: a reference line goes to `citations`, a bare URL line to
  `source_url`. A record with no file (File Name "Not available", 26 records,
  mostly `web link`) gets `external_url` from it.
- Contributor → the contribution owner (below); Resource Matrix →
  `education_topics`; `Project -- group -- name` → `project`/`project_group`;
  a trailing version token of Computer Program → `computer_program_version`.
- The text format splits `List` cells on `:`, so a colon inside an item
  becomes ` -`; UTF-8 stored as Latin-1 (`â€œ`) is repaired; long text is
  flattened to one line.
- **Listed file sizes are unreliable.** Records 1601–1706 (a batch of stereo
  field images) list sizes 1024× too large ("527.63 MB" for a 540,296-byte
  PNG; their TIFFs are really up to ~3.3 GB, over `max_file_bytes`); the pages'
  total of 76.5 TB is really ≈129 GB. `--max-file-mb` defers files listed
  above a size; `--max-total-gb` (default 20) refuses a larger download.
- 151 records list files the archive no longer has ("Missing file"): 149 are
  the `10.58052/…` argon-data uploads (ids 2567–2715, contributor "ArArCALC
  ERDA Uploader"), plus 806 and 1842. Records with a missing or deferred file
  stay out of the inventory (`excluded.json`).

**First run (2026-09-29, files listed ≤ 100 MiB).** 2,160 records in the
inventory (2,995 attachments, 7.07 GB); 258 records deferred (329 larger
files: ≈47 GB, plus ≈75 GB real for the 1601–1706 batch, 13 files over
2 GiB); 151 legacy-missing. 198 contributor names matched 195 accounts (all
already on dev); 21 names are unmatched, 160 inventory records depend on the
placeholder `default_owner`. Every generated file validates except record 2741
(a test record titled "1", data type "Not specified"). A `sync-legacy` dry run
against a fresh local `erda` schema plans 2,000 records and reports exactly the
160 `default_owner` records as "owner mapping missing".

**Owners.** The contributor display name maps to an `er_users` account by
**exact full name** (given + family) only; several documents with one email
count as one account. `owner_mapping.json` lists every name with its records,
the matched account, and, for unmatched names, same-name or case-variant
candidates plus the account at the page's legacy person id (`erml.cgi?n=`,
which is the `er_users` id) as a hint that is never applied. `owner_names`
overrides a name; every other unmatched record goes to `default_owner`, which
is a placeholder (`…@placeholder.invalid`) until a steward account is chosen,
so those records fail `sync-legacy` with "owner mapping missing".
