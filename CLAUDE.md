# Claude Development Context

## What This Is

FIESTA is the platform behind the EarthRef.org data repositories (nodes): MagIC, KdD, CDR, KArAr, ERDA, OSU-MGR. One codebase serves any node; a deployment is fully described by one YAML in `config/`. Rebuilt from scratch in July 2026 (Meteor/Semantic-UI → FastAPI + Vite/React). The direction as of 2026-09-10 is **one FIESTA API for every node** (`/v1/{node}/...`) that the SPA talks to directly — see `ROADMAP.md` Phase A. Long-form rationale lives in `docs/`, `development.md`, `deployment.md` and `ROADMAP.md`; this file is the rules.

## Stack

```
Backend:    FastAPI + SQLAlchemy (async) + asyncpg + Pydantic v2 + Alembic      (backend/, package `fiesta`)
API:        one process, `fiesta.apps.api` — every node under /v1/{repository}/... (api.earthref.org, and what the SPA talks to); `config/fiesta.yaml` lists the nodes, FIESTA_NODE narrows them
Jobs:       procrastinate (Postgres-native LISTEN/NOTIFY) — parse / validate / summarize / index, email
Frontend:   Vite + React + TanStack Router/Query SPA, Tailwind; one build serves any node (branding from the API)
Database:   Postgres 16 — shared `users` schema + one schema per node (magic, cdr, …), Alembic per schema
Search:     OpenSearch, one index per node (FIESTA_INDEX_PREFIX when the cluster is shared)
Storage:    S3-compatible (prod: AWS S3, one bucket + `<slug>/` prefix; local: MinIO) — canonical files + manifest.json
Email:      SMTP (local: Mailpit :8025)
Infra:      Docker Compose locally (`make up` = hot-reload overlay, `PROD=1` = built images); deploy.yml runs /srv/fiesta/bin/deploy-fiesta.sh on the self-hosted runner `fiesta-ct` (label fiesta-deploy) on push to main — it is a release-dir swap (uv sync + ruff/pytest, npm ci + per-node vite build with base paths, `fiesta init` per node, symlink /srv/fiesta/current, health checks), no docker compose, so compose changes never reach production
Linting:    ruff (Python), biome (TypeScript)
```

## Repo Layout

```
config/                <node>.yaml + <node>/{data_models/*.json, vocabularies}; fiesta.yaml lists every node the API serves
backend/fiesta/        apps/ (api.py — one FastAPI, routers/, deps) · domain/ (parse, validate, summarize)
                       services/ (contributions, rebuild) · jobs/ (procrastinate) · search/ · plugins/ · cli.py
backend/alembic/       migrations (applied per node schema by `fiesta init`)
backend/tests/         pytest (domain + plugins; no infra needed)
frontend/src/          routes/ components/ lib/ (api.ts, config.ts, base.ts) plugins/<name>/
docs/                  api.md (contract) · plugins.md · legacy-ux-spec.md (pixel-level Meteor UI parity spec)
                       <node>-node.md · OPERATOR_TODO.md (human-only actions)
old-backend/           legacy Koa/OpenSearch API — READ-ONLY porting reference, never edited
scripts/               e2e.sh (full workflow against a running stack), pg-node-readonly-role.sql
../MagIC ../CDR ../KArAr ../KDD ../FIESTA-API   sibling legacy repos — reference for data models, vocab, UI, API
.claude/skills/        /roadmap-next (reconcile ROADMAP.md, propose next) · /operator-todo (docs/OPERATOR_TODO.md)
```

## Commands (use exactly these forms — they match the permission allowlist)

```bash
make up                         # compose: infra + one API (/v1/{node}/…, API_PORT) + one worker + a frontend per node in FIESTA_NODE (.env); hot reload (Vite dev server, uvicorn --reload) — a git pull is live; returns once healthy
make up FIESTA_NODE=magic       # one node; PROD=1 runs the built images (what CI e2e and a deployment use)
make down / make clean          # stop (keep volumes) / stop and DELETE volumes
make infra                      # only postgres+opensearch+minio+mailpit, for host-run app processes
make backend-dev                # uv sync + fiesta init + uvicorn fiesta.apps.api --reload for every node in FIESTA_NODE (:8000)
make worker-dev                 # procrastinate worker for every node in FIESTA_NODE
make frontend-dev               # Vite on :5173 for the first FIESTA_NODE (nvm use first — Node 22); VITE_API_TARGET=http://localhost:18000 to re-point
make test                       # backend pytest + frontend tsc/build   (make test-backend / make test-frontend)
make lint / make fix            # ruff + biome check / auto-fix
make e2e                        # scripts/e2e.sh against a running `make up FIESTA_NODE=magic PROD=1`
make init / make rebuild / make user EMAIL=… NAME=…   # run once on the `api` service
cd backend && uv run pytest tests/test_domain.py -x --tb=short
cd backend && FIESTA_CONFIG_FILE=../config/fiesta.yaml FIESTA_NODE=magic uv run fiesta <init|rebuild --yes|worker|create-user>
```

On this machine host ports 5432/8000/8001 are taken: `.env` publishes Postgres on 55432 and the API on `API_PORT` (the old per-node `<NODE>_BACKEND_PORT` variables are retired, so this machine's `.env` must set `API_PORT`, e.g. 18000). `make e2e API_PORT=…` reads the same override. `.env` holds secrets — do not print it.

## Hard Rules (each links to its rationale)

- **Postgres owns application state; the bucket preserves immutable contribution history; OpenSearch is a projection.** Save content through the revision service with optimistic concurrency and an idempotency key. Commit revision pointers and outbox events together. Never edit published revision content or erase retained history. `fiesta rebuild` rebuilds search only; full recovery needs Postgres plus S3. Local development uses Docker and per-node seed manifests, never production credentials. → [docs/phase-m.md](docs/phase-m.md)
- **A node is a YAML file, never a code branch.** Identity, colors, index, bucket, data model, vocabularies, hierarchy, facets, and enabled features all live in `config/<node>.yaml`; the loader validates it on startup and CI loads every YAML. No `if node == "magic"` in core code. → [README.md](README.md), [development.md](development.md) "Adding or changing a node"
- **Node-specific science is a plugin** (`backend/fiesta/plugins/` + `frontend/src/plugins/<name>/`, activated by `features.plugins`). Poles, depth plots, age plateaus, record cards, digital objects — all plugins. New node feature ⇒ new plugin, not a core special case. → [docs/plugins.md](docs/plugins.md)
- **Data models and vocabularies are the legacy repos' JSON, converted, not rewritten.** `config/<node>/data_models/<version>.json` comes from the Meteor repos' `export const` modules. MagIC 3.0 gotchas: no `experiments` table (it is a derived search level); longitudes are 0–360; `lab_names`, `citations`, `geologic_types`, `lithologies`, `age_unit`, `reference` are required — fixtures and seeds must satisfy them.
- **Search documents keep the legacy shape** `{type, summary: {contribution, <level>, _all}, rows}`; `summary._all` unions row values (capped 500/column) for free-text search; workflow flags `_is_activated` / `_is_latest` / `_private_key` live in `summary.contribution`. Public reads are always `_is_latest` and `_is_activated` unless a matching private key is supplied. → [docs/api.md](docs/api.md)
- **Visibility is enforced server-side in one place.** Private contributions are visible only to their contributor (or admin) or via `private_key`; plugin routes go through `fiesta.plugins.util.load_visible_parsed`. Never add a route that reads a contribution file without that check.
- **Multi-node isolation invariants**: contributions carry a `node` column; each node has its own Postgres schema, OpenSearch index, bucket prefix, and procrastinate queue; accounts are shared (one EarthRef login). A migration runs once per node schema under a `schema_translate_map`, but Alembic's `add_column` / `alter_column` / `drop_column` render the schema literally and bypass it (CI e2e failure 2026-09-10): in those ops use the resolved `context.config.attributes["node_schema"]` / `["shared_schema"]` set by `alembic/env.py`, never the `NODE_SCHEMA` token; `create_table` / `create_index` may use either. Legacy Meteor apps share the OpenSearch cluster with indices named plainly `magic`, `cdr`, … — `fiesta rebuild` deletes and recreates an index, so `FIESTA_INDEX_PREFIX` is mandatory on any shared cluster.
- **UI parity is a spec, not a vibe.** Legacy Meteor UI behaviour is recorded in [docs/legacy-ux-spec.md](docs/legacy-ux-spec.md); deviations are decisions recorded there or in `ROADMAP.md`, not accidents.
- **`old-backend/` and the sibling legacy repos are read-only reference.** Port from them; never edit them from a FIESTA session.
- **Never `git stash`/pop to compare against HEAD** — the tree can carry concurrent uncommitted work.
- **Sessions do not share this tree for edits.** A session that will modify files runs `EnterWorktree` first (subagents: `isolation: "worktree"`); one that must edit here anyway commits ONLY by explicit pathspec (`git commit -- <files>`, never `git add .`/`-a`) and checks `git status` on each file it touches immediately before committing.
- **Claude merges its own PRs.** Once the work is committed on the worktree branch, pushed, and `make lint` + `make test` are green locally, open the PR with exactly one of the labels `feature|bug|refactor|upgrade|docs|internal|security|breaking` (`gh pr create --label feature …`; the `check-labels` job fails on zero or two labels, and the auto-labeler adds `docs` only for all-Markdown PRs and `internal` only for all-`.github`/`scripts` PRs) and merge it yourself when `gh pr view <n> --json mergeable` says `MERGEABLE` and the `CI` check is green — `gh pr merge <n> --merge` (no `--delete-branch`: it fails from a worktree because `main` is checked out in the main tree; `git push origin --delete <branch>` and `ExitWorktree` remove instead). A PR with conflicts is rebased onto `origin/main` and re-pushed, never merged with conflicts; if the rebase needs a judgement call, stop and ask. Nothing deploys on merge today — production rollout is a human action (OPERATOR_TODO).
- **Human-only actions** (prod credentials, AWS/OpenSearch/Postgres access, DNS, ORCID/EZID registrations, CORS on the live API, cutover decisions) go in [docs/OPERATOR_TODO.md](docs/OPERATOR_TODO.md), never only in chat.

## Models and Delegation

The main session runs Claude Fable 5.1. Subagents default to Opus 4.8 (`CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-4-8` under `env` in `.claude/settings.json` — that file is gitignored, so set it per clone); override per call:

- `sonnet` (Sonnet 5) for read-only fan-out: Explore searches, file inventories, comparing a legacy repo's module against ours, sifting compose logs, capturing screenshots.
- default (Opus 4.8) for judgement workers: code review, porting one legacy feature in a worktree, a bounded refactor of one router or one plugin, reviewing a node YAML against its data model. Same tier as Opus 5 and the same tokenizer as Fable, without the classifiers that make Fable and Opus 5 decline some security-shaped requests, and it rarely delegates further.
- `fable` for the orchestrator's own work and for a subtask that is itself open-ended and hours long (e.g. the Phase A API unification). Not `opus` (Opus 5) for workers: nothing over 4.8 on a bounded task.

Delegate when work fans out across independent items (six node YAMLs, the per-node plugins, every route in a router, per-page UI parity checks against `docs/legacy-ux-spec.md`); launch in the background and keep working. A single-file read or a sequential check is done directly. Give a subagent the goal, the constraints, and where the answer goes, not the steps. Editing subagents use `isolation: "worktree"`.

Edit files surgically; never rewrite a file to change a few lines. Scratch checks live in the scratchpad; commit a test only where the task asks for one or the neighbouring module already keeps tests for that kind of change (`backend/tests/test_domain.py`, `test_plugins.py`).

## Skills (`.claude/skills/`)

`/roadmap-next` (reconcile ROADMAP.md with `git log`, propose the next 1–3 items, separating code work from operator blockers) · `/operator-todo` (maintain docs/OPERATOR_TODO.md).

## Domain Model (one line each; details in docs/api.md and backend/fiesta/db/models.py)

`users` (shared schema; email/handle, `orcid`, `is_admin`) → `contributions` (per-node schema; `node`, `version`/`previous_id`, `private_key`, `is_activated`/`is_latest`, `data_model_version`, `reference_doi`, `filename`, `status` ∈ created|uploaded|parsing|validating|summarizing|ready|failed) → bucket objects `<prefix><id>/<filename>` + `manifest.json`; search docs per node index (`type` = contribution | hierarchy level | plugin-derived type); procrastinate queues = node slug + `default` (email). Node config: `NodeConfig` in `backend/fiesta/nodeconfig.py` (identity, search levels/facets, storage, data_model versions, vocabularies, hierarchy, doi prefix, features.pages/plugins).

## What NOT to Add

Meteor, Semantic-UI, Blaze, Koa (all replaced); Redis/Celery (procrastinate is the queue); a second search engine; per-node forks of core code; node-specific env vars (everything node-specific goes in the YAML). Do not resurrect the deleted template workflows (`test.yml`, `playwright.yml`, `smokeshow.yml`, `add-to-project.yml`, `issue-manager.yml`, `latest-changes.yml`) — `ci.yml` replaces them.
