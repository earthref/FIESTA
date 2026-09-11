# Roadmap

> Written 2026-09-10. This is the planning record for FIESTA: what is built, what is
> decided, what is next, and what is parked. `CLAUDE.md` holds the rules; this file
> holds the plan. Keep it honest with `/roadmap-next` (reconcile against `git log`,
> update status markers only when the code is on `main`). Human-only steps live in
> `docs/OPERATOR_TODO.md`, not here.
>
> Status markers: **DECIDED** (direction fixed, no code) · **IN PROGRESS** ·
> **BUILT <date>** (on `main`) · **DEPLOYED <date>** (confirmed on a live host) ·
> **BLOCKED (operator)**.

## Where we actually are — 2026-09-10

Counted from the tree, not estimated:

| | |
|---|---|
| Nodes configured (`config/*.yaml`) | 6 — MagIC, KdD, CDR, KArAr, ERDA, OSU-MGR |
| Plugins | poles (MagIC), depth-plot (CDR), plateau-calculations (KArAr), record-cards, digital-objects (ERDA) |
| Backend apps | 2 — node app (`/api`, one process per node) + public API (`/v1`, all nodes) |
| Backend tests | 26 (domain + plugins; no infra) — routers are covered only by `scripts/e2e.sh` |
| Frontend routes | home, search, contribution, private workspace, upload, validate, data-models, vocabularies, method-codes, contact, login; **6 stubs** (about, technology, grand challenges, workshops, links, help) |
| CI | `ci.yml` (ruff, pytest, biome, tsc/build, every YAML loads, compose e2e) — committed 2026-09-10; first run failed on the e2e job (migration 0002, fixed same day) |
| Deploy | `deploy.yml` → self-hosted runner `fiesta-ct` (label `fiesta-deploy`) running `/srv/fiesta/bin/deploy-fiesta.sh`: release dir under `/srv/fiesta/releases`, uv sync + tests, npm ci + per-node vite build (`/MagIC/`, `/KdD/`, …), `fiesta init` per node, symlink swap, health checks. Runner back online 2026-09-10 evening; every merge since deploys in ~1 min. `fiesta init` logs "procrastinate schema: Database error." on each node — check it. Production still runs the legacy Meteor apps |
| Local stack | `make up` = infra + backend/worker/frontend **per node** (6 duplicated compose triplets) |

**Read of the position.** The core workflow (register → upload → validate → publish
→ search → download → `/v1`) works end to end, six nodes load from YAML, and
node-specific science is isolated in plugins. What stands between this and replacing
the Meteor apps is: (1) a backend shape contributors can work against without
production credentials, (2) the legacy features that were never ported, (3) UI parity
on the pages people actually use, and (4) a deploy and cutover story. In that order.

## The thesis

- **One codebase, any node, one YAML per node.** Nothing node-specific in core code.
- **The bucket is the record.** Postgres and OpenSearch are rebuildable projections.
  Every feature must survive `fiesta rebuild --yes`.
- **One API.** The SPA and external clients hit the same versioned surface,
  `/v1/{node}/...`. Frontend contributors point at the live API with their EarthRef
  login and need no infrastructure; backend contributors run one API locally with seed
  data. Decided 2026-09-10.
- **Parity before novelty.** Until cutover, the measure of a page is
  `docs/legacy-ux-spec.md`, not a redesign.

## The near-term order (decided 2026-09-10)

1. **Phase A — one FIESTA API.** Unblocks everything about contributor onboarding
   and removes six copies of the compose stack.
2. **Phase B — contributor dev experience.** Seed data, frontend-only mode, docs.
3. **Phase C — port the remaining legacy features.** Required for cutover, mostly
   independent of each other, so they fan out well to subagents in worktrees.
4. **Phase D — UI parity and the stub pages.**
5. **Phase E — deployment and cutover.** Needs operator decisions first.
6. **Phase F — keep it up.** Tests for routers, branch protection, dependency bumps.

Before any of it: get `CI` green on `main` (the migration 0002 fix and the log-dump fix
from 2026-09-10) and untrack `.claude/settings.proposed.json`.

## Phase A — One FIESTA API — **DECIDED 2026-09-10**

Collapse the per-node node app into the public API's shape: one FastAPI service, node
named in the path, one deployment YAML listing every node. `backend/fiesta/apps/public.py`
already resolves the node per request from `{repository}` and binds the session to that
node's schema, and the CLI's `init` / `rebuild` / `worker` already loop over all nodes —
the node app is the outlier.

- [ ] **A1 Deployment config.** One YAML listing nodes (the current `public-api.yaml`
      shape) becomes the only deployment mode; `FIESTA_NODE` filters which nodes a
      local stack enables. Retire `deployment: node`. CI's "every YAML loads" job
      adapts.
- [ ] **A2 Node per request.** `NodeDep` resolves `{node}` from the path (case-insensitive
      key or slug); `get_session` depends on it; lifespan ensures every enabled node's
      bucket and index; plugin routers mount at concrete slugs
      (`/v1/magic/plugins/poles`). Node-less routes: `/v1/auth/*`, `/v1/health-check`.
- [ ] **A3 Merge the two apps.** `/api` folds into `/v1`: config, data models,
      vocabularies, method codes, the full private workspace (validate/validation,
      reference, activate/deactivate), contribution summary + download. Add a token
      login on `/v1` for the SPA; HTTP Basic stays for legacy `api.earthref.org`
      clients. Rewrite `docs/api.md` as the single contract.
- [ ] **A4 Jobs.** `process_contribution` takes the node slug as an argument instead
      of the process-global config; one worker listens on every enabled node's queue
      (the CLI already does this).
- [ ] **A5 Frontend.** `VITE_API_URL` selects the API origin (live or local);
      node from `FIESTA_NODE` at dev time and injected by the frontend container's
      nginx at runtime (one image, any node, any base path). All 28 `api()` calls and
      the 4 direct download/texture URLs gain the node prefix.
- [ ] **A6 Compose and docs.** One `api` + one `worker` + a frontend per enabled node;
      delete the six triplets; Makefile, `.env.example`, `scripts/e2e.sh`,
      `development.md`, `deployment.md`, README ports table.

Acceptance: `make up FIESTA_NODE=magic,karar` starts infra + 1 API + 1 worker + 2
frontends; `make e2e` and CI green; `GET /v1/karar/config` and `GET /v1/magic/config`
served by the same process.

Order of work: A1 → A2 → A3 → A4 (backend, one PR or two) → A5 (frontend) → A6.

## Phase B — Contributor dev experience

- [ ] **B1 `fiesta seed`.** A demo account plus a few contributions per node from
      fixture files (satisfying the required MagIC 3.0 columns), processed inline so
      search works immediately. `make seed`. Idempotent.
- [ ] **B2 Frontend-only mode against live data.** `FIESTA_NODE=magic
      VITE_API_URL=https://api.earthref.org make frontend-dev` with an EarthRef login.
      Needs the live API to allow the localhost Vite origin in CORS — **BLOCKED
      (operator)** until a FIESTA API is live (Phase E); until then the target is the
      local seeded API.
- [ ] **B3 Docs for contributors.** `development.md` rewritten around the two
      workflows (frontend-only vs. backend); a short CONTRIBUTING.md pointing at it,
      `make` targets, and the PR flow.
- [ ] **B4 Port conflicts.** `.env.example` documents the override pattern; consider
      defaulting the compose stack to high ports so a fresh clone never collides.

## Phase C — Port the remaining legacy features

Reference: `old-backend/` (Koa) and the sibling `../FIESTA-API`, `../MagIC` repos.
Each item is independent and PR-sized; good subagent-in-worktree work.

- [ ] **C1 DOI minting (EZID)** on activation when `doi.prefix` is set. Credentials —
      **BLOCKED (operator)** for the live path; build against a fake first.
- [ ] **C2 ORCID OAuth login** (the `users.orcid` column exists; no flow). Client
      registration — **BLOCKED (operator)**.
- [ ] **C3 Contribution upgrade** 2.x → 3.0 (MagIC) — port the upgrade maps from the
      legacy data-model JSON.
- [ ] **C4 Derived experiment docs** — MagIC's `experiments` search level is derived
      from measurements, not a table; port `summarize_contribution.js`'s experiment
      grouping as a plugin `derive_docs` hook or core summarizer step.
- [ ] **C5 Excel upload** (`.xlsx` → contribution text) in the upload wizard.
- [ ] **C6 Reference enrichment** — Crossref/DataCite lookup on `reference_doi` to
      fill `summary.contribution._reference` (authors, year, journal) as the legacy
      search docs have it.
- [ ] **C7 `/v1` compatibility audit** against `../FIESTA-API`'s OpenAPI: `id`, `doi`,
      `format=json` params, response shapes, error codes. Diff, then close the gaps.

## Phase D — UI parity and the stub pages

- [ ] **D1 Stub pages** — About, Technology, Grand Challenges, Workshops, Links, Help
      get per-node content (YAML `features.pages` already lists which a node shows).
- [ ] **D2 Parity pass per route** against `docs/legacy-ux-spec.md`; record every
      deliberate deviation in that file. Search page pass shipped 2026-09-10
      (legacy tabs/filters/sort/infinite scroll, result card cells, globe map
      thumbnail, `sort` API param); deviations listed in the spec's search section.
- [ ] **D3 Mobile** — the drawer shipped 2026-08-26; the search and contribution pages
      still need a pass at phone width.
- [ ] **D4 Poles globe** per `docs/poles-globe-spec.md` — check what remains.

## Phase E — Deployment and cutover

Every item here starts with a human decision (hosting, credentials, DNS).

- [ ] **E1 Hosting decision** and a CI deploy on push to `main` — **BLOCKED (operator)**.
- [ ] **E2 Import the existing contributions** into the bucket layout (canonical file +
      `manifest.json` per contribution) from the legacy stores, then `fiesta rebuild`.
      Needs sizing: source of the files, how versions/`previous_id` map, DOIs.
- [ ] **E3 Shared-cluster safety** — `FIESTA_INDEX_PREFIX` set, read-only Postgres
      roles per node (`scripts/pg-node-readonly-role.sql`).
- [ ] **E4 dev.earthref.org/<Node>/** path-prefix deployment, then `earthref.org/<Node>/`
      as a reverse-proxy change only.

## Phase F — Keep it up (ongoing)

- [ ] Router tests without a compose stack (fake S3 + in-memory search, or a
      testcontainers job in CI) so `make test` covers what only `make e2e` does today.
- [ ] Branch protection on `main` with the `CI` job required.
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
- `f98d3a6` `scripts/e2e.sh` replaces the obsolete build/push/deploy/test scripts
- Dependabot: actions bumps (#3, #4, #5, #8)
- `ba4a1df` CLAUDE.md, ROADMAP.md, OPERATOR_TODO.md, skills, `ci.yml` (replaces `test.yml`, `playwright.yml`, `smokeshow.yml`)

### July 2026 — the rebuild

FastAPI + async SQLAlchemy + procrastinate backend, Vite/React SPA, Postgres 16 +
OpenSearch + MinIO compose stack, YAML-per-node config, plugins (poles, depth-plot,
plateau-calculations), multi-node compose profiles, per-node Postgres schemas, public
`/v1` API compatible with the legacy surface.
