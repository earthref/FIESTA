# The OSU-MGR node

The Oregon State University Marine and Geology Repository ([osu-mgr.org](https://osu-mgr.org))
curates marine and terrestrial sediment cores, dredged and ROV-collected rocks,
and the data collected from them. Its existing stack is a Next.js/TinaCMS site
over an OpenSearch index built by `osu-mgr-pipeline/osu_mgr_pipeline.py`, which
walks the repository's S3 object store and its Excel metadata sheets. This node
ports that document model onto FIESTA.

**Scope: holdings, not measurements.** The MST and XRF series that come off this
material are published through the **CDR** node — that pipeline already exists
(`osu-mgr-pipeline/CDR_PREVIEW.md` maps OSU MST/XRF columns onto CDR
`measurements`). Here the same data appears only as `files` rows of type
`mst-data` / `xrf-data`. Duplicating the measurements would give the same
numbers two homes and two DOIs.

## Data model 1.0

Ten tables. OSU-MGR has **two hierarchy branches**, which FIESTA's linear
`hierarchy` list flattens; the parentage that matters is carried by each table's
`in("<parent>.<key>")` column, not by the list order.

```
contribution
└── cruises
    ├── cores ── sections ── section_halves ── core_samples     (coring)
    └── dives ── dive_samples ── dive_subsamples                (dredge / grab / ROV)
files ── attach to any level above, by osu_id + level
```

A station takes the dive branch when its type code is `D`, `G` or `SG`
(`DIVE_TYPE_CODES` in the pipeline). ROV samples are filed there too but keep
the collection method `ROV`.

| Table | Grain | Pipeline `_docType` |
|---|---|---|
| `contribution` | One cruise's holdings — the accession unit | — |
| `cruises` | The cruise or programme | `cruise` |
| `cores` | A cored/drilled station | `core` |
| `sections` | A cut section of a core | `section` |
| `section_halves` | Archive half, working half, or whole round | `sectionHalf` |
| `core_samples` | A satisfied sample request against a section half | `coreSample` |
| `dives` | A dredge, grab, or ROV station | `dive` |
| `dive_samples` | An individual rock ("Rocks" in the repository's search) | `diveSample` |
| `dive_subsamples` | A subsample cut from a rock | `diveSubsample` |
| `files` | A data file, image, or document | the `_files` blocks |

**One contribution per cruise.** That is the grain the repository actually
works at: material is accessioned per cruise, the metadata sheet is per cruise,
and moratoria are applied and lifted per cruise folder in S3.

**Files are polymorphic.** They attach at eight different levels, so the parent
is one `osu_id` column plus a `level` (`cv("osu_level")`) rather than CDR
`supplements`' one-column-per-parent shape, which does not scale past a single
branch.

**Longitudes are −180/180** (marine convention), not MagIC's 0–360.

## Vocabularies

Generated from the pipeline's own constants and the IGSN inventory, so they
match what is actually in the index rather than a transcription of it:

| Vocabulary | Terms | Source |
|---|---|---|
| `core_type` | 33 | `CORE_TYPES` (code → display name) |
| `collection_method` | 34 | distinct `CORE_TYPES` values + `ROV` |
| `file_type` | 26 | the `FILE_TYPES` patterns |
| `section_half_type` | 3 | `SECTION_HALF_TYPES` (Archive/Working/Round) |
| `osu_level` | 8 | the hierarchy tables, for `files.level` |
| `collection` | 3 | MGG / ACC / Oregon Drill Core holdings |
| `sesar_resource_type` | 11 | observed in `igsn-inventory/registered_*.csv` |

Suggested (warnings, not errors): `material` (Rock, Sediment) and `texture`
(47 principal textures mined from the SESAR sample titles, which encode
`<OSU-ID> <method> <material> <texture>`). Both come from free-text sheet
columns, so a controlled vocabulary would reject valid new values.

`sample_status` is deliberately left as a plain String — the sample-request
sheet's `▼ Status ▼` column has no enumerable value set in the source.

## Search

Tabs: **Contributions, Cruises, Cores, Sections, Dives, Rocks, Files**.
`section_halves`, `core_samples` and `dive_subsamples` are `extra_types` —
searchable via `/v2/{node}/search/{table}` without a tab, matching the repository's
own search, which exposes cores, cruises, dives and rocks as types.

Facets: `file_type`, `method`, `material`, `texture`, `rv_name`,
`pi_institution`, `collection` — the repository search's filter groups (file
types, collection methods, materials, RV names, institutions).

Result cards come from the `record-cards` plugin (see plugins.md), laid out
by `plugins.record-cards.cards` in osu-mgr.yaml (one card per search table,
editable in the admin UI's Plugins tab).

**Index name is `osumgr`, not `osu-mgr`.** The repository's own pipeline owns an
OpenSearch alias called `osu-mgr`; keeping the names distinct lets a FIESTA
deployment share a cluster with the pipeline without either clobbering the other.

## Known gaps

- **Moratorium is described, not enforced.** `cruises.moratorium` /
  `moratorium_expiration` and the same pair on `files` record the state, but
  FIESTA's visibility rules are `_is_activated` + `_private_key`. Withholding
  moratorium files from search and download, and lifting them on the expiration
  date, needs core support — a moratorium is not the same thing as an
  unactivated contribution.
- **IGSN registration.** The model carries `igsn`, `alternate_igsn` and
  `sesar_resource_type`, but minting and syncing with SESAR is not wired up
  (neither is EZID DOI minting, for any node).
- **Denormalized rollups.** `cruises.methods`, `cruises.materials` and the
  cruise bounding box are marked `downloadOnly()` because the pipeline computes
  them in `denormalize()`. FIESTA's `summarize()` produces the equivalent in
  `summary._all`, so these columns are for round-tripping exports, not input.
- **No importer.** Nothing yet converts the pipeline's index documents (or the
  Excel metadata sheets) into FIESTA contribution files. The mapping is
  one-to-one for every column above, so this is a transformation, not a
  redesign.

## Unrelated observation

`osu-mgr-pipeline/osu_mgr_pipeline.py` hard-codes a live OpenSearch URL with
username and password at module scope (`OPENSEARCH_HOST`), and the repository
tracks it in git. That credential should move to the `.env` the module already
loads, and be rotated.
