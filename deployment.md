# FIESTA - Deployment

A FIESTA deployment = `config/fiesta.yaml` (which lists the nodes) + the compose
stack (or the equivalent services in your orchestrator).

## Roles

| Role | Config | Entrypoint |
|---|---|---|
| API (every node under `/v2/{node}/...`) | `config/fiesta.yaml` | `uvicorn fiesta.apps.api:create_app --factory` |
| Worker | `config/fiesta.yaml` | `fiesta worker` |

Both run from the same `backend/` image; the role is just the command. One API
process serves every node listed in `config/fiesta.yaml`; `FIESTA_NODE`
(comma-separated keys/slugs, empty = all) narrows the set a process serves.

## Multiple nodes on one instance

Set `FIESTA_NODE` to a comma-separated list (e.g. `magic,karar,cdr`) and the
compose stack runs one API + one worker for every listed node plus one frontend
per node, all against shared infrastructure. Isolation per node: its own
OpenSearch index, MinIO bucket, procrastinate job queue, and node-scoped
contribution rows in Postgres; user accounts are shared (one EarthRef login
works on every node). Concurrent start-up is safe — `fiesta init` serializes
schema migrations behind a Postgres advisory lock. In front of it all, route
each node's hostname (e.g. `karar.earthref.org`) to that node's frontend
container, whose nginx proxies `<base>v2/` to the API (`BACKEND_HOST`, default
`api`); the node is named in the path, so one API serves them all.

## Several nodes on one hostname

The alternative to a hostname per node is a path prefix per node on one
hostname (`dev.earthref.org/MagIC/`, `/CDR/`, ...; eventually
`earthref.org/MagIC/`). Set `<NODE>_BASE_PATH=/MagIC/` per node in `.env` —
see development.md, "Several nodes on one hostname". The frontend image is
built for exactly one base path, so a node published at both shapes needs
two images. Moving the FIESTA nodes from `dev.earthref.org/<Node>/` to
`earthref.org/<Node>/` at cutover is then a reverse-proxy change only: the
images, base paths, and containers stay the same.

## External infrastructure (Postgres, OpenSearch, S3 outside compose)

The compose stack is for development. A deployment normally points the app
processes at existing services instead; nothing else about the app changes.

| Setting | Notes |
|---|---|
| `FIESTA_DATABASE_URL` | SQLAlchemy form or a plain libpq URL (`postgresql://u:p@host:1523/fiesta?sslmode=verify-full&sslrootcert=system&target_session_attrs=read-write`). libpq params are translated for asyncpg and passed through to procrastinate. |
| `FIESTA_DB_SHARED_SCHEMA` | Schema for the shared `users` table (default `public`). Each node's tables live in a schema named after its slug. |
| `FIESTA_OPENSEARCH_URL` | `https://user:pass@host:9400` — scheme and credentials come from the URL. `FIESTA_OPENSEARCH_VERIFY_CERTS` / `FIESTA_OPENSEARCH_CA_CERTS` for TLS. |
| `FIESTA_INDEX_PREFIX` | Prepended to every node's `search.index`. **Set it whenever the cluster is shared** (e.g. `fiesta-`): `fiesta rebuild` deletes and recreates the node's index, and the legacy Meteor apps use indices named plainly `magic`, `cdr`, `karar`, `kdd`. |
| `FIESTA_S3_ENDPOINT` | Leave empty for AWS S3; set for MinIO or other S3-compatible stores. |
| `FIESTA_S3_BUCKET` | One shared bucket for all nodes, each under a `<slug>/` key prefix (AWS bucket names are global, so the YAML's `magic` is not available there). Unset = one bucket per node as named in the YAML. |
| `FIESTA_S3_ACCESS_KEY` / `FIESTA_S3_SECRET_KEY` / `FIESTA_S3_REGION` | An IAM user scoped to that bucket only. |

### Schema per node

Postgres holds one schema per node (`magic`, `cdr`, ...) for the contribution
workflow tables and one shared schema for accounts. `fiesta init` migrates
each node's schema separately (each keeps its own `alembic_version`), so a
multi-node Postgres has one schema per node and one `users` table. This is
what lets a node's developers be granted access to just their node:
`scripts/pg-node-readonly-role.sql` creates such a role.

Local compose databases created before this layout have their tables in
`public`; run `make clean` once to start from an empty volume.

## Environment

Infrastructure/secrets come from `FIESTA_*` env vars (see
`backend/fiesta/settings.py`): `FIESTA_DATABASE_URL`, `FIESTA_OPENSEARCH_URL`,
`FIESTA_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY`, `FIESTA_SECRET_KEY`,
`FIESTA_SMTP_*`, `FIESTA_CORS_ORIGINS`. Everything node-specific lives in the
YAML, not in env vars.

Run `fiesta init` once per deploy (idempotent): applies Alembic migrations,
the procrastinate schema, and ensures the bucket + search index exist.

## Disaster recovery / migration

Postgres backups and the revision bucket are both required. Restore the database
first into an isolated environment, attach the matching immutable bucket objects,
and verify references before exposing the API:

```sh
fiesta init             # apply compatible schema migrations
fiesta verify-storage   # checks retained revisions, manifests and file checksums
fiesta rebuild --yes    # rebuild search only, then switch its alias
fiesta drain-outbox     # retry pending work
```

Retain database base backups and WAL archives for PITR, the corresponding S3 object
versions, deployment configuration and application image. Never expire objects
referenced by retained revisions. `fiesta rebuild` preserves users, settings and
workspace permissions; it cannot recover lost Postgres state from contribution
manifests. See [Phase M operations](docs/phase-m.md) for migration and cutover gates.

## The production deploy script

The production rollout (`/srv/fiesta/bin/deploy-fiesta.sh` on the `fiesta-ct`
runner — not in this repo) predates Phase A: it still starts a per-node uvicorn
process per node and proxies `/api`. It must change to run **one**
`uvicorn fiesta.apps.api:create_app` with
`FIESTA_CONFIG_FILE=config/fiesta.yaml` (optionally `FIESTA_NODE` to narrow the
set), proxy `<base>v2/` to that single process instead of `/api`, and build each
node's SPA with `VITE_NODE=<slug>` (or serve `fiesta-env.js` per node) so the
frontend resolves its node and API origin. This is tracked in
[OPERATOR_TODO](OPERATOR_TODO.md).

## Production notes

- Put the frontend's nginx (or any reverse proxy) in front of the API and
  route `<base>v2/*` to it — the SPA calls `/v2/{node}/...` on its own origin.
- Set a strong `FIESTA_SECRET_KEY`; tokens are HS256 JWTs.
- OpenSearch: single index per node, created automatically with mappings from
  `fiesta/search/index.py`; re-run `fiesta rebuild` after mapping changes.
