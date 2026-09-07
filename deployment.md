# FIESTA - Deployment

A FIESTA deployment = one YAML file from `config/` + the compose stack (or the
equivalent services in your orchestrator).

## Roles

| Role | Config | Entrypoint |
|---|---|---|
| Node (MagIC/CDR/KArAr) | `config/<node>.yaml` | `uvicorn fiesta.apps.node:create_app --factory` |
| Public API | `config/public-api.yaml` | `uvicorn fiesta.apps.public:create_app --factory` |
| Worker | same as its node | `fiesta worker` |

All three run from the same `backend/` image; the role is just the command +
`FIESTA_CONFIG_FILE`.

## Multiple nodes on one instance

Set `FIESTA_NODE` to a comma-separated list (e.g. `magic,karar,cdr`) and the
compose stack runs one backend + worker + frontend per node against shared
infrastructure. Isolation per node: its own OpenSearch index, MinIO bucket,
procrastinate job queue, and node-scoped contribution rows in Postgres; user
accounts are shared (one EarthRef login works on every node). Concurrent
start-up is safe — `fiesta init` serializes schema migrations behind a
Postgres advisory lock. In front of it all, route each node's hostname
(e.g. `karar.earthref.org`) to that node's frontend container, which proxies
`/api` to its own backend via the `BACKEND_HOST` env var.

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

The bucket is the durable record (canonical contribution files +
`manifest.json` per contribution). To rebuild a node from scratch:

```sh
fiesta init
fiesta rebuild --yes    # restores contributions to Postgres and re-indexes OpenSearch
```

Accounts restored from manifests have no passwords (manifests never store
credentials) — users reset via the normal flow. Only back up Postgres if you
want to preserve password hashes and accounts that never contributed.

## Production notes

- Put the frontend's nginx (or any reverse proxy) in front of the backend and
  route `/api/*` to it — the SPA only uses relative URLs.
- Set a strong `FIESTA_SECRET_KEY`; tokens are HS256 JWTs.
- OpenSearch: single index per node, created automatically with mappings from
  `fiesta/search/index.py`; re-run `fiesta rebuild` after mapping changes.
