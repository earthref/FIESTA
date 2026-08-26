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
