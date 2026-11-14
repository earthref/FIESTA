# Roadmap

> Written 2026-09-10. This is the planning record for FIESTA: what is built, what is
> decided, what is next, and what is parked. `CLAUDE.md` holds the rules; this file
> holds the plan. Keep it honest with `/roadmap-next` (reconcile against `git log`,
> update status markers only when the code is on `main`). Human-only steps live in
> `OPERATOR_TODO.md`, not here.
>
> Status markers: **DECIDED** (direction fixed, no code) · **IN PROGRESS** ·
> **BUILT <date>** (on `main`) · **DEPLOYED <date>** (confirmed on a live host) ·
> **BLOCKED (operator)**.

## Where we actually are — 2026-09-10

Counted from the tree, not estimated:

| | |
|---|---|
| Nodes configured (`configurations/*.yaml`) | 6 — MagIC, KdD, CDR, KArAr, ERDA, OSU-MGR |
| Plugins | poles, rock-mag (MagIC), depth-plot (CDR), plateau-calculations (KArAr), digital-objects (ERDA); record cards became per-level summary grid `columns` (2026-09-30) |
| Backend apps | 1 — `fiesta.apps.api`: `/v2/{node}/...` for every node plus the frozen legacy `/v1` api.earthref.org contract (`routers/v1.py`) |
| Backend tests | 84 (domain, plugins, deployment, the `/v1` contract against a fake session; no infra) + the Phase M integration suite in Docker; `fiesta/scripts/e2e.sh` drives the compose stack |
| Frontend routes | home, search, contribution, private workspace, upload, validate, data-models, vocabularies, method-codes, contact, login; **6 stubs** (about, technology, grand challenges, workshops, links, help) |
| CI | `ci.yml` (ruff, pytest, biome, tsc/build, every YAML loads, compose e2e) — committed 2026-09-10; first run failed on the e2e job (migration 0002, fixed same day) |
| Deploy | `deploy.yml` → self-hosted runner `fiesta-ct` (label `fiesta-deploy`) running `/srv/fiesta/bin/deploy-fiesta.sh`: release dir under `/srv/fiesta/releases`, uv sync + tests, npm ci + per-node vite build (`/MagIC/`, `/KdD/`, …), `fiesta init` per node, symlink swap, health checks. Runner back online 2026-09-10 evening; every merge since deploys in ~1 min. `fiesta init` logs "procrastinate schema: Database error." on each node — check it. Production still runs the legacy Meteor apps |
| Local stack | `make up` = infra + one API + one worker + one frontend serving every node in `FIESTA_NODE` at `:8080/<Key>/` (2026-09-14; the per-node frontend ports and compose profiles are gone) |

**Read of the position.** The core workflow (register → upload → validate → publish
→ search → download → `/v2`) works end to end, six nodes load from YAML, and
node-specific science is isolated in plugins. What stands between this and replacing
the Meteor apps is: (1) a backend shape contributors can work against without
production credentials, (2) the legacy features that were never ported, (3) UI parity
on the pages people actually use, and (4) a deploy and cutover story. In that order.

## The thesis

- **One codebase, any node, one YAML per node.** Nothing node-specific in core code.
- **Postgres owns application state; the bucket preserves contribution history;
  OpenSearch is a rebuildable search projection.** New direction 2026-09-11; the
  implementation and recovery contract must change through Phase M below.
- **One API.** The SPA and external clients hit the same versioned surface,
  `/v2/{node}/...`. Frontend contributors point at the live API with their EarthRef
  login and need no infrastructure; backend contributors run one API locally with seed
  data. Decided 2026-09-10.
- **Parity before novelty.** Until cutover, the measure of a page is
  `legacy-ux-spec.md`, not a redesign.

## The near-term order (decided 2026-09-10)

1. **Phase A — one FIESTA API.** Unblocks everything about contributor onboarding
   and removes six copies of the compose stack.
2. **Phase B — contributor dev experience.** Seed data, frontend-only mode, docs.
3. **Phase C — port the remaining legacy features.** Required for cutover, mostly
   independent of each other, so they fan out well to subagents in worktrees.
4. **Phase D — UI parity and the stub pages.**
5. **Phase E — deployment and cutover.** Needs operator decisions first.
6. **Phase F — keep it up.** Tests for routers, branch protection, dependency bumps.

**Added 2026-09-11: Phase M — data migration and redesign.** Start the data contract
alongside Phase A; build revision storage and reliable indexing before online
editing, then migrate and continuously sync legacy data. M is a prerequisite for
Phase E's production cutover, with node pilots possible before the full migration.

Before any of it: get `CI` green on `main` (the migration 0002 fix and the log-dump fix
from 2026-09-10) and untrack `.claude/settings.proposed.json`.

## Phase A — One FIESTA API — **DECIDED 2026-09-10** — **DONE 2026-09-12**

Collapse the per-node node app into the public API's shape: one FastAPI service, node
named in the path, one deployment YAML listing every node. `fiesta/backend/fiesta/apps/public.py`
already resolves the node per request from `{repository}` and binds the session to that
node's schema, and the CLI's `init` / `rebuild` / `worker` already loop over all nodes —
the node app is the outlier.

- [x] **A1 Deployment config.** One YAML listing nodes (the current `public-api.yaml`
      shape) becomes the only deployment mode; `FIESTA_NODE` filters which nodes a
      local stack enables. Retire `deployment: node`. CI's "every YAML loads" job
      adapts.
- [x] **A2 Node per request.** `NodeDep` resolves `{node}` from the path (case-insensitive
      key or slug); `get_session` depends on it; lifespan ensures every enabled node's
      bucket and index; plugin routers mount at concrete slugs
      (`/v2/magic/plugins/poles`). Node-less routes: `/v2/auth/*`, `/v2/health-check`.
- [x] **A3 Merge the two apps.** `/api` folds into `/v2`: config, data models,
      vocabularies, method codes, the full private workspace (validate/validation,
      reference, activate/deactivate), contribution summary + download. Add a token
      login on `/v2` for the SPA; HTTP Basic stays for legacy `api.earthref.org`
      clients. Rewrite `api.md` as the single contract.
- [x] **A4 Jobs.** `process_contribution` takes the node slug as an argument instead
      of the process-global config; one worker listens on every enabled node's queue
      (the CLI already does this).
- [x] **A5 Frontend.** `VITE_API_URL` selects the API origin (live or local);
      node from `FIESTA_NODE` at dev time and injected by the frontend container's
      nginx at runtime (one image, any node, any base path). All 28 `api()` calls and
      the 4 direct download/texture URLs gain the node prefix.
- [x] **A6 Compose and docs.** One `api` + one `worker` + a frontend per enabled node;
      delete the six triplets; Makefile, `.env.example`, `fiesta/scripts/e2e.sh`,
      `development.md`, `deployment.md`, README ports table.

Acceptance: `make up FIESTA_NODE=magic,karar` starts infra + 1 API + 1 worker + 2
frontends; `make e2e` and CI green; `GET /v2/karar/config` and `GET /v2/magic/config`
served by the same process.

Verified by `make e2e` locally and CI's e2e job.

Order of work: A1 → A2 → A3 → A4 (backend, one PR or two) → A5 (frontend) → A6.

## Phase B — Contributor dev experience

- [x] **B1 `fiesta seed`.** (Shipped with M0; verified from a fresh clone with no `.env`
      2026-10-12, all seven nodes; the developer account is a super admin since 2026-10-22.) Implement with M0: per-node YAML selects checked-in
      seed manifests and fixtures, including demo accounts and representative
      contribution histories. `make seed` waits for processing so search works
      immediately. Idempotent; no MARFIK or AWS connection required. 2026-11-09:
      the public examples come from dev.earthref.org instead (each node's 50 most
      recent public contributions not already local); the hand-made ones load
      only with `fiesta seed --fixtures`, which the offline phase-m test uses.
- [ ] **B2 Frontend-only mode against live data.** `FIESTA_NODE=magic
      VITE_API_URL=https://api.earthref.org make frontend-dev` with an EarthRef login.
      Needs the live API to allow the localhost Vite origin in CORS — **BLOCKED
      (operator)** until a FIESTA API is live (Phase E); until then the target is the
      local seeded API.
- [x] **B3 Docs for contributors.** (2026-10-22: CONTRIBUTING.md — fork, `make up` +
      `make seed`, rules, checks, PR flow; README quick start seeds; development.md
      seed section moved up and host-run targets documented. The frontend-only
      workflow against the live API waits on B2.) `development.md` rewritten around the two
      workflows (frontend-only vs. backend); a short CONTRIBUTING.md pointing at it,
      `make` targets, and the PR flow.
- [ ] **B4 Port conflicts.** `.env.example` documents the override pattern; consider
      defaulting the compose stack to high ports so a fresh clone never collides.

## Phase G — Admin settings — **G1 DONE 2026-09-24**

- [x] **G1 Super admins, node admins, and node configuration in the admin UI.**
      `users.is_admin` = super admin, `node_admins` = per-node admins. `/admin`
      manages accounts and nodes: settings, data models, vocabularies, files,
      admins, history and rollback. Drafts live in Postgres. Publishing
      serves the draft and writes it to git (PR from `node-config/<slug>`), and
      `fiesta init` imports trees merged in git. New nodes start from a template
      node. Decided 2026-09-24: Postgres is the source while a node is edited, and
      git receives every publication. Not in the legacy Meteor UI, so there is no
      parity spec.
- [x] **G3 Pages and Search Filters tabs (2026-09-24).** Content pages are
      configuration: YAML `pages` (slug, title, menu placement, icon; list order =
      menu order) with HTML in `configurations/<node>/pages/`, one SPA route for all of
      them, DOMPurify on render (pages and home news). `features.pages` is gone;
      the six stub pages became MagIC pages with the stub text (D1 is now content
      work in the admin UI). The filter sidebar is YAML `search.filters` (facet /
      range / bbox with levels and views); the poles range/bbox filters moved from
      the plugin into magic.yaml. CDR and KArAr facets pointed at columns their
      data models do not have (never any buckets): CDR now lists the legacy
      sidebar's eight, KArAr four of its own columns.
- [x] **G4 Plugins tab (2026-09-24).** Every plugin declares an `Options` pydantic
      model (defaults, descriptions, constraints); per-node options live in the
      YAML's `plugins.<name>` map and are validated at startup and before every
      publication. The poles display columns / base level / colors, the depth-plot
      series / levels / depth columns, the plateau constants and the record cards
      (formerly `CARDS_BY_NODE`, keyed by node name in Python) moved into the five
      YAMLs; `frontend_config` output is unchanged for every node. The Plugins tab
      lists every plugin with its description, switches it on or off per node and
      edits its options through a form generated from the schema.
- [ ] **G2 Follow-ups.** Disable/delete accounts and invitation emails; structured
      editors for search levels, hierarchy, home cards/news and method codes (today:
      the YAML/JSON file editor); the deploy script builds a frontend for every
      published node, including nodes whose PR is not merged yet.
- [ ] **G5 Curation tools.** After cutover, fixing published data means an admin
      creating a new revision of someone's contribution, attributed to both. Transfer
      ownership (MagIC #154); only the contributor or an admin creates a new version
      (#329, verify `/versions`); lab names locked after activation (#506); correct a
      reference's metadata over `doi_references` (#88); batch fixes across many
      contributions (#374, #301, #331, #610); a report of duplicate contributions and
      DOIs with more than one contribution (#552, #527); users request new method
      codes and vocabulary entries for the node admins (#27).

## Phase C — Port the remaining legacy features

Reference: `old-backend/` (Koa) and the sibling `../FIESTA-API`, `../MagIC` repos.
Each item is independent and PR-sized; good subagent-in-worktree work.

*2026-11-13: the 181 open issues in `earthref/MagIC` were reviewed against FIESTA. The
ones FIESTA still has to solve are folded into C1, C3, C5, C8–C10, G5, D5, M2/M3 and
M8 below, cited as "MagIC #n". Data-model questions (#619, #620, #623, #630, #309,
#325, #326, #379) and one-off fixes to specific legacy contributions stay in that repo;
the latter become G5 work after cutover.*

- [ ] **C1 DOI minting (EZID)** on activation when `doi.prefix` is set. Credentials —
      **BLOCKED (operator)** for the live path; build against a fake first. Make the
      DOI public at activation (MagIC #17). Before porting, audit the existing data
      DOIs: pre-3.0 ones do not resolve (#585) and many contributions have none
      (#511). DOI hygiene with it: fill the reference DOI from an uploaded
      contribution table (#279, #395, #284); store `https://doi.org/…` as a bare DOI
      (#373); re-check private contributions whose DOI was not yet on Crossref and
      email the contributor when it is (#3, on C6's schedule); publisher links and
      DataCite related identifiers (#228, #229); schema.org `unitCode` (#508).
      Decision: publishing with a URL instead of a DOI (#16) — today a resolving
      DOI is required.
- [ ] **C2 ORCID OAuth login** (the `users.orcid` column exists; no flow). Client
      registration — **BLOCKED (operator)**.
- [ ] **C3 Contribution upgrade** 2.x → 3.0 (MagIC) — port the upgrade maps from the
      legacy data-model JSON. Let the contributor ignore or rename unknown columns
      (MagIC #308) and accept or convert the old model's blank values (#521).
- [ ] **C4 Derived experiment docs** — MagIC's `experiments` search level is derived
      from measurements, not a table; port `summarize_contribution.js`'s experiment
      grouping as a plugin `derive_docs` hook or core summarizer step.
- [ ] **C5 Tabular import** — the legacy upload's "Step 2": `.xlsx`/`.xls`/`.csv`
      → contribution text in the upload wizard, with sheet/table detection, header
      rows, a column-name suggester, skipping tables, worksheets and columns, value
      rounding with a warning for too many significant digits, and saved import
      templates covering every table (MagIC #10, #11, #12, #13, #127, #133, #149,
      #231, #248, #253, #273, #274, #283, #310, #344, #398, #425, #426, #428,
      #490, #558; dropping a folder #40). Lab file formats (BGC and the other
      legacy converters, #588) as plugins that convert to contribution text.
- [x] **C6 Reference enrichment** (2026-09-28) — Crossref, then DataCite, for
      each `reference_doi`, cached in the shared `doi_references` table and set on
      the search docs as the legacy `_reference` (title, journal, year, citation,
      authors with ORCIDs, n_citations, html). Fetched by the outbox worker when a
      revision names a DOI and weekly after (monthly until 2026-11-13, when OpenAlex
      was added: more ORCIDs, the larger citation count, and an abstract, citations
      per year, topics and open-access link on the contribution panel);
      `fiesta enrich-references` backfills.
- [x] **C7 Legacy `/v1` contract** (2026-09-13). FIESTA's own API moved to `/v2`;
      `/v1` is a port of `old-backend`'s api.earthref.org surface (`routers/v1.py`,
      its published YAML at `/v1/openapi.yaml`, Koa error bodies, HTTP Basic),
      unit-tested without infra (`tests/test_v1.py`) and round-tripped in the
      Phase M integration suite. `reference_title` matches `_reference.title`
      (filled by C6).
- [ ] **C11 Upload and online-editing parity with legacy MagIC** (inventory
      2026-11-13 against `MagIC/client/modules`: `upload_contribution.jsx`,
      `common/components/data_importer.jsx`, `private_contributions.jsx`,
      `fiesta/components/edit_contribution_modal.tsx`). Already at parity: the
      workspace list, name, DOI with citation lookup, description / lab names /
      funding / supplement fields, delete, share link and preview, validate with
      errors and warnings per table, publish gated on zero errors and a DOI. FIESTA
      adds revisions with restore, attachments, new versions of published
      contributions and per-revision validation. Missing:
      - [ ] Intake: several files at once; `.xlsx`/`.xls` (one table per sheet, the
            MagIC Excel template's 3 header rows and group column skipped); single-table
            tab- and comma-delimited files; a file-type override; example files (C5).
      - [ ] Import step: table name per sheet, a column suggester (model name or
            label, case-insensitive), a column picker that flags unknown and duplicate
            targets, header-row count, excluding columns, rows and tables, value
            normalisation (Integer `.0`, booleans, controlled-vocabulary case and
            one-letter typos), and refusing two measurements tables (C5).
      - [ ] Import templates: save, load, rename and delete per user (C5).
      - [ ] Upload into an existing private contribution, replacing the tables the
            new file contains ("Add Data to This Contribution", MagIC #327).
      - [ ] Grid editor: tables as tabs, cell editing with edited cells marked, add
            and delete rows, undo and redo, vocabulary pulldowns, show/hide empty
            columns, paging, and validation errors on the cells (M3, MagIC #547).
      - [x] Workspace card: a New Contribution button, a download button, and
            reassigning a private contribution to another user (G5).
- [ ] **C8 Finish the validator.** `domain/validate.py` accepts but does not enforce
      `requiredIf`/`requiredUnless` variants, `in`, `matrix` and `type`. Enforce
      them, `requiredIfGroup` per row, not per table (MagIC #564, which is why the
      legacy rules were pulled from the data model). An empty `recommended()`
      column warns, never fails (#590). Fix or reject capitalisation errors (#453)
      and upper-case column names (#363); keep large integers from breaking the
      OpenSearch mapping (#485); catch the missing-table errors legacy missed
      (#423). Data-model defaults for blank cells (#410) and a "maybe required"
      label (#259). Clearer messages (#399, #454, #491). Warnings plus calculated
      values, and fixing values on the validation page (#263, #441, #518).
      MagIC-specific consistency checks (directions recomputed from `magn_x/y/z`
      to catch frame and sign-convention errors, #622) go in a plugin.
- [ ] **C9 Downloads.** Expose the stored sha256 checksums (MagIC #613); strip a
      leading UTF-8 BOM from served legacy files (#621); the contribution ID and
      metadata in every downloaded file (#291, #315); no stray `>>>>` separators
      (#311); text cells starting with `@` survive Excel (#497). Compressed and
      multi-contribution downloads (#463, #343) and a download dialog (#509, #316).
- [ ] **C10 Usage statistics.** Download counts per contribution (MagIC #135) and
      an internal contribution statistics page (#365).

## Phase D — UI parity and the stub pages

- [ ] **D1 Stub pages** — About, Technology, Grand Challenges, Workshops, Links, Help
      get per-node content: since G3 they are `pages` entries with HTML under
      `configurations/<node>/pages/`, written in the admin UI's Pages tab; the legacy
      text still needs porting.
- [ ] **D2 Parity pass per route** against `legacy-ux-spec.md`; record every
      deliberate deviation in that file. Search page pass shipped 2026-09-10
      (legacy tabs/filters/sort/infinite scroll, result card cells, globe map
      thumbnail, `sort` API param); deviations listed in the spec's search section.
- [ ] **D3 Mobile** — the drawer shipped 2026-08-26; the search and contribution pages
      still need a pass at phone width.
- [x] **D4 Poles globe** — replaced 2026-09-28 by the MapLibre views with plate
      boundaries and a95 / dp-dm outlines (deviations at the top of
      `configurations/plugins/poles/globe-spec.md`). A Rock Magnetism view (`rock-mag` plugin) shipped
      alongside it on the Specimens level.
- [ ] **D5 Search and contribution-page issues from legacy MagIC.** Part of D2,
      listed so none are lost. Filters: lower levels return only matching rows
      (MagIC #213), the age range filter (#350), "contains" for ranges (#349), sort
      by the filtered value (#206), external IDs (#574), case-insensitive authors and
      isotopic stages / chron boundaries in the timescale filter (#517), say so when a
      DOI search finds nothing (#137). Map: every location shown (#95, #520), the
      geospatial boundary drawn (#186, #332). Contribution page: group by level
      (#194), hide empty columns (#269), all method codes (#290), pole count on the
      summary (#282). Plots: captions (#446) and loading at scale (#452, #546, #550).
      Formatting: author names (#152), significant digits (#189), age units and age 0
      (#280, #288), long DOIs (#304). Accounts: contributor names link to ORCID
      (#400), return to the page after login (#496). Poles: re-test #582, #583, #584
      on the MapLibre view.

## Phase M — Data migration and redesign — **IN PROGRESS**

Direction: make Postgres the authoritative data layer for accounts, private
workspaces, user settings, permissions, and contribution management; synchronize
searchable contribution projections to OpenSearch. Move every node's legacy S3
contributions into the shared FIESTA bucket, preserving history and attachments,
with repeatable incremental imports until cutover. The SPA's online editor,
uploads, and external FIESTA API clients must use the same revision workflow.
The details below are the recommended design to implement, not shipped behavior.

**Local development is a requirement — added 2026-09-11.** Developers must be able
to build and exercise Phase M entirely against Docker Postgres, OpenSearch, MinIO,
and Mailpit, with the API, worker, and selected node frontends. No MARFIK PG/OS,
AWS credentials, production account, or live contribution download is required.
Image/package downloads during initial setup are separate from runtime service
dependencies. Live-API frontend development remains optional.

Put a seed selector in each node YAML, for example
`development: {seed_manifest: magic/seeds/manifest.yaml}`, resolved relative to
that YAML. Keep the manifest, small contribution files, and attachments under
`configurations/<node>/seeds/`; reuse shared synthetic account fixtures where appropriate.
This is a proposed config extension, not a currently supported field. Seed
manifests describe stable fixture IDs, account/workspace roles, settings, revision
sequences, files, and expected validation/publication states. Include valid public
data, private drafts, failing validation, multiple revisions/published versions,
attachments, and representative enabled plugins for each node. Use synthetic or
redistributable public data, never production credentials or private user data.

**Implementation inputs.** M0–M4 can start using repository data models and
synthetic fixtures without production access. Establish workspace roles and
sharing semantics, the settings to support, editor scope (start with explicit
saves and optimistic concurrency), and deletion/history retention before those
contracts are finalized. M5–M6 additionally need a per-node source inventory and
representative legacy metadata/file exports: bucket/key conventions, identity and
ownership mappings, version/DOI links, visibility, and how updates/deletions are
recorded. Infer these from the legacy repositories first and record remaining
ambiguities. Build import/sync against local legacy fixtures before a live dry
run. Production rehearsal and M7 need scoped source-read/destination-write access,
sizing, backup/restore targets, and an agreed cutover/rollback window; track these
operator inputs in `OPERATOR_TODO.md` when preparing the live migration.

**Implementation branch — 2026-09-11.** `feature/phase-m` implements migration 0003,
Postgres settings/workspace permissions, immutable file revisions and undo, shared
management routers, the SPA text/history/attachment editor, durable outbox processing,
versioned validation/summary artifacts, config-driven offline seeds, explicit-inventory
legacy import/sync, storage verification, and search-only rebuild. Local Docker
verification is tracked in [storage-and-migration.md](storage-and-migration.md). Status remains IN
PROGRESS until reviewed and merged; checkboxes below are not claims of deployment.
Live source inventories/export mappings, production sizing and backup/cutover
rehearsals remain operator gates in `OPERATOR_TODO.md`. Phase A's process
consolidation remains separate; the current Docker stack still runs per-node APIs
and workers plus the multi-node API.

**Starting point and change in contract.** Postgres already stores shared users,
node-scoped contributions, and validation results. This is an extension and
redesign, not the first addition of Postgres. Current storage overwrites a
contribution's file and manifest, and `fiesta rebuild` restores contribution rows
and placeholder accounts from manifests. That cannot preserve full account state,
settings, workspace permissions, or private edit history. This direction supersedes
the roadmap's former "Postgres is a projection" rule; update the matching rule in
`CLAUDE.md`, README, storage/rebuild documentation, and recovery tooling when
implementing M1. Bucket-only recovery must no longer claim to restore the whole app.

**Recommended ownership and artifact storage.**

| Store | Responsibility |
|---|---|
| Postgres | Accounts/authentication, settings, workspace membership and permissions, contribution identity and published-version links, immutable revision metadata, current draft/published pointers, audit events, processing status, artifact references, and transactional indexing outbox. |
| FIESTA S3 bucket | Immutable original uploads, canonical text, supplemental documents, images and other assets; revision manifests identifying the complete file set by key/checksum; versioned validation reports and derived indexing artifacts. All keys scoped by node and contribution. |
| OpenSearch | Denormalized scientific search documents derived from selected revisions. No account/settings authority; private workspace listing and editing work without it. Never copy credentials or account settings into search documents. |

**Recommendation: store both validation results and summarized indexing documents
in the bucket alongside the contribution's revision.** Keep validation runs as
historical evidence of what passed or failed at that time; a later validator run
creates a new report and does not replace the original. Keep summaries and plugin
documents as regenerable artifacts, useful for inspection and faster reindexing.
Postgres holds compact status/counts and artifact pointers for UI/API queries.
Neither artifact is editable source data or the mechanism for undo.

Use a layout such as
`<node>/contributions/<id>/revisions/<revision-id>/manifest.json`, with immutable
file references and `artifacts/<run-id>/` for reports and compressed indexing
documents. Record revision/input checksums, data-model and vocabulary versions,
validator/summarizer/plugin versions, configuration hash, artifact schema version,
and run timestamps. Preserve or identify the exact processing inputs. Reuse a
summary only when its provenance matches the requested index build; otherwise
regenerate it. Apply current visibility from Postgres when indexing, never from
an old cached summary. Keep private files, manifests, reports, and summaries behind
the same API authorization checks.

- [ ] **M0 Docker development and config-driven seeds.** Deliver alongside B1
      before the new workflows. Reuse the existing Compose infrastructure and
      converge with Phase A's single API/worker. Provide documented
      `make up FIESTA_NODE=magic,cdr` and `make seed FIESTA_NODE=magic,cdr` workflows
      using only local services, with local demo login and deterministic substitutes
      for DOI minting, OAuth, and reference enrichment. Keep local endpoint settings
      separate from production configuration; seed/reset commands must refuse
      non-development targets and never inherit MARFIK/AWS endpoints silently.
      Seed through the contribution services so revisions, artifacts, validation,
      and indexing follow real workflows. Repeated seeds must not duplicate data
      or overwrite developer edits; make fixture reset a separate, explicit local
      operation. Add synthetic legacy buckets and metadata snapshots to exercise
      initial import, subsequent changes/deletions, and interrupted/resumed sync.
      Run these workflows in CI with external service access disabled after setup,
      and validate every node's seed manifest and representative fixtures.
- [ ] **M1 Postgres authority and recovery.** Model shared account settings and
      node/workspace permissions, contribution revisions, draft/published pointers,
      and audit history. Route management reads/writes and authorization through
      Postgres. Separate index rebuild from explicit data restoration; index
      rebuild must not recreate users or overwrite application state. Design and
      rehearse Postgres backup/PITR plus bucket recovery, including reconciliation
      of revision references after restore. PostgreSQL documents the required
      base backups and WAL archive in its [PITR guide](https://www.postgresql.org/docs/16/continuous-archiving.html).
- [ ] **M2 Immutable revisions and undo.** Every accepted edit, upload, attachment
      addition/removal, and contribution metadata change creates a revision with
      parent, actor, timestamp, operation, and complete snapshot references.
      Reuse unchanged immutable blobs. Undo creates a new revision restoring an
      earlier snapshot; published versions stay immutable and retain legacy
      `id`/`previous_id`/DOI semantics separately from private draft revisions.
      Record permission/publication events separately from content undo so undo
      cannot restore obsolete access grants. Retain all accepted private revisions;
      define explicit deletion/retention rules and never garbage-collect blobs
      referenced by retained history. Enable S3 Versioning as additional object
      recovery protection, while application revisions group changes across files
      and metadata ([S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)).
- [ ] **M3 Shared editing/upload/API workflow.** Add revision list/read/restore,
      draft save, attachment management, upload finalization, validation, and
      publication to `/v2/{node}/...`. Use expected-revision checks to reject
      conflicting saves and idempotency keys for retries. Stage and verify immutable
      objects before committing a revision and its outbox event in one Postgres
      transaction; reconcile abandoned uploads and interrupted operations. Bind
      validation and publication to the exact revision so stale successful
      validation cannot publish newer unvalidated edits. From legacy MagIC: a diff
      between versions (MagIC #34); the online editor's gaps — delete a row, undo
      and redo, vocabulary pulldowns and links, a hint that tables are editable
      (#547); the contribution's history of completed and running actions (#427);
      supplemental data links and images as attachments (#504, #347). #434 and #435
      (private files in S3, rollback) close when M2/M3 ship.
- [ ] **M4 Durable processing and Postgres → OpenSearch sync.** Process revision
      events asynchronously with retries, deduplication, per-contribution ordering,
      stale-job protection, failure visibility, and reconciliation. Persist M's
      validation/summary artifacts with provenance. Track indexing status separately
      from whether a draft was saved or validated; OpenSearch downtime must not
      block account management, workspace access, uploads, or editing. Reindex from
      Postgres revision selections plus bucket data/artifacts into a new index,
      then switch the alias. Recheck visibility against Postgres before returning
      results, counts, facets, or downloads so indexing lag cannot expose withdrawn
      or private data.
- [ ] **M5 Inventory and initial legacy import.** *2026-09-14: `fiesta legacy-inventory` +
      `ensure-owners` shipped (PR #32) and KArAr was imported into the MARFIK data layer
      that `dev.earthref.org/KArAr/` serves: 21 contributions (12 public+latest, 2 superseded,
      7 private), 3 owners. Remaining nodes need a `legacy:` block each; all KArAr validations
      fail on model/vocabulary parity (`age_is_preferred` table, boolean `t/f` vs `True/False`).
      2026-09-16: MagIC imported (PR #35): 7,658 of 7,726 legacy contributions (6,994 public,
      664 private), 318 owners; 68 skipped (66 with no matching account, 2 with no file and
      no indexed tables). Legacy MagIC shares one private key per version chain and has
      blank header cells — both handled. `.zip` companions (up to 17 GB each) are not copied
      yet. KdD and CDR wait on decisions in OPERATOR_TODO §A.*
      For each configured node, map
      source buckets/prefixes and metadata sources, count objects/bytes and versions,
      and identify canonical files, supplemental docs, images, ownership, private
      state, timestamps, DOIs, and version chains. Import available historical
      versions; record missing history rather than inventing it. Preserve public
      identifiers and links, map legacy users explicitly, and quarantine ambiguous
      ownership as inaccessible pending resolution. Build a dry-run, resumable,
      idempotent migration script with source-to-target mappings, checksums,
      checkpoints, and error reports. Verify complete revision file sets before
      committing imported metadata; retain originals and flag validation failures
      without silently altering legacy published data.
- [ ] **M6 Incremental legacy sync until cutover.** Extend that script to discover
      new/updated files and metadata-only changes (including visibility, ownership,
      publication, and deletions). Use source version IDs/checksums and metadata
      fingerprints, overlap scan windows, and periodic full reconciliation; do not
      assume ETags are content hashes. Append changed imports as revisions and
      record tombstones without erasing history. Keep legacy authoritative per
      node until cutover; pilot edits use isolated copies so sync cannot overwrite
      FIESTA edits. Report lag, changed/skipped/failed contributions, bytes, and
      unresolved mappings after every run.
- [ ] **M7 Rehearsal and cutover gate.** Pilot representative public/private,
      multi-version, and attachment-heavy contributions for every node. Reconcile
      inventories/checksums, owners, visibility, DOIs, version chains, downloads,
      validation, and search parity. Prepare a per-node runbook: freeze legacy
      writes, final delta and reconciliation, drain indexing, switch reads/writes,
      then disable legacy sync. Preserve legacy sources through an agreed rollback
      window. Rollback after FIESTA accepts writes requires preserving/replaying
      those revisions, not just switching traffic back. Coordinate live access,
      write freezes, and cutover approvals through `OPERATOR_TODO.md`.
- [ ] **M8 GEOMAGIA (new node, 2026-11-13).** GEOMAGIA50's archeomagnetic and
      volcanic records are hosted as `geomagia`: data model from its MySQL schema,
      vocabularies from its ID glossary, mirrored from the public 2019 CSV export by
      `configurations/sources/geomagia.py` (`legacy.kind: script`); `publish.web: false`.
      Next: a MySQL reader once there is a SELECT-only account (OPERATOR_TODO), an
      age-curve plugin (intensity / inclination / declination against age), then the
      sediment database. GEOMAGIA's field-model engine stays in its Django service.
      Interop with MagIC (MagIC #628): links both ways between matching records,
      and GEOMAGIA datasets missing from MagIC queued for import.

Acceptance: a fresh checkout starts and seeds selected nodes in Docker without
MARFIK/AWS access, supports local login/edit/upload/undo/search, and repeats seed
without damaging developer changes; every node's inventory reconciles with explicit exceptions; repeated
syncs neither duplicate nor lose changes; original and historical files download
correctly; API and SPA saves share conflict/undo behavior; stale validation cannot
publish another revision; private access remains correct during indexing lag;
management and editing work with OpenSearch stopped; indexing catches up after
restart; a restore drill recovers accounts, settings, permissions, revisions, and
attachments before rebuilding search. No unresolved ownership or privacy mismatch
at cutover.

## Phase E — Deployment and cutover

Every item here starts with a human decision (hosting, credentials, DNS).

- [ ] **E1 Hosting decision** and a CI deploy on push to `main` — **BLOCKED (operator)**.
- [ ] **E2 Complete Phase M's migration and cutover gates.** Initial import,
      incremental sync, history/attachment verification, and the final delta are
      tracked in M5–M7; use M1's recovery contract rather than bucket-only rebuild.
- [ ] **E3 Shared-cluster safety** — `FIESTA_INDEX_PREFIX` set, read-only Postgres
      roles per node (`fiesta/scripts/pg-node-readonly-role.sql`).
- [ ] **E4 dev.earthref.org/<Node>/** path-prefix deployment, then `earthref.org/<Node>/`
      as a reverse-proxy change only.

## Phase F — Keep it up (ongoing)

- [ ] Router tests without a compose stack (fake S3 + in-memory search, or a
      testcontainers job in CI) so `make test` covers what only `make e2e` does today.
- [x] Branch protection on `main` (2026-10-22): ruleset "Protect main" requires a PR,
      one approval and green `CI` + `check-labels`; repository admins bypass through a
      PR only (`gh pr merge --admin`). The default Actions token is read-only and
      workflows cannot approve PRs.
- [ ] Dependabot PRs: merge on green CI, batch the actions bumps.

## Parked, with reasons

- **Single multi-node frontend** (one SPA that switches node from the URL). Wanted
  eventually for `earthref.org/<Node>/`; parked until A5's runtime node injection is
  in, which makes it a router change rather than a build change.
- **Frontend-only mode against production data before a FIESTA API is live.** The
  legacy `api.earthref.org` does not serve the SPA's contract; not worth an adapter.

## Non-goals

Meteor/Blaze/Semantic-UI resurrection; a second search engine; per-node code forks;
interactive chat/AI features in the app.

## Shipped

### 2026-08-26 → 2026-09-10

- `7e475b8` node config + storage handling (shared-bucket prefix, index prefix)
- `d8cff3c` removed template deploy workflows (prod/staging)
- `8d13df6` `7b20ccc` OSU-MGR node, suggested vocabularies, node doc
- `92eab2b` ERDA node + digital-objects plugin
- `a15a8b9` mobile drawer + icon set
- `f98d3a6` `fiesta/scripts/e2e.sh` replaces the obsolete build/push/deploy/test scripts
- Dependabot: actions bumps (#3, #4, #5, #8)
- `ba4a1df` CLAUDE.md, ROADMAP.md, OPERATOR_TODO.md, skills, `ci.yml` (replaces `test.yml`, `playwright.yml`, `smokeshow.yml`)

### July 2026 — the rebuild

FastAPI + async SQLAlchemy + procrastinate backend, Vite/React SPA, Postgres 16 +
OpenSearch + MinIO compose stack, YAML-per-node config, plugins (poles, depth-plot,
plateau-calculations), multi-node compose profiles, per-node Postgres schemas, public
`/v2` API compatible with the legacy surface.
