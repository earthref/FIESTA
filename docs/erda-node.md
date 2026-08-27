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
| Keywords, Parameters, Materials, Samples | the same four `List` columns on `objects` |
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

Result cards come from the `record-cards` plugin (see plugins.md); without
it the default MagIC-shaped card would render nothing but "No … Data".

## Known gaps

- **Age-range search.** `age_high`/`age_low` are `Number` columns, but the
  shared index mapping types every cell as text (`numeric_detection: false`),
  so a `range` filter on them would compare lexically. Numeric age-range
  search needs an explicit mapping for these fields in
  `fiesta/search/index.py` — a core change, deliberately not made here.
- **Object bytes.** The data model describes the files; actually storing and
  serving per-object downloads (rather than the canonical contribution file)
  is a storage/API concern, not a data-model one.
- **Legacy import.** No migration from the `er_*` schema yet. Sampling
  `earthref.org/ERDA/{id}/` over ids 1–4900 finds roughly 2,600 live
  records (IDs are sparse; nothing resolves above ~4,300).
