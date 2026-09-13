<p align="center">
  <img src="logo.png?raw=true"/>
</p>
<h1 align="center">FIESTA</h1>
<p align="center">
  <b>Framework for Integrated Earth Science and Technology Applications</b>
</p>

FIESTA is the platform behind the EarthRef.org data repositories (nodes):
[MagIC](https://earthref.org/MagIC), [CDR](https://earthref.org/CDR), and
[KArAr](https://earthref.org/KArAr).

One codebase serves any node. A deployment is fully described by a single YAML
file in [`config/`](config/) — node name, branding colors, OpenSearch index,
storage bucket, data model, controlled vocabularies, summarization hierarchy,
and enabled features. `config/fiesta.yaml` lists the nodes one API process
serves; `FIESTA_NODE` narrows that list for a local stack.

## Architecture

```
frontend    Vite + React + TanStack Router/Query SPA (branding fetched from /v1/{node}/config)
api         FastAPI + SQLAlchemy (async) + asyncpg + Pydantic v2 + Alembic — one process,
            every node under /v1/{node}/... (api.earthref.org, and what the SPA talks to)
worker      procrastinate (Postgres-native jobs): parse/validate/summarize/index, email
postgres    Accounts + contribution workflow state (Postgres 16)
opensearch  Denormalized search documents, one index per node
minio       S3-compatible storage: canonical contribution files + manifests
```

**Durability:** Postgres owns accounts, permissions, settings and contribution
revision pointers. The bucket preserves immutable files, revision manifests and
processing artifacts. `fiesta rebuild` rebuilds only OpenSearch; recovery requires
Postgres backups plus the bucket. See [Phase M operations](docs/phase-m.md).

## Quick start

```sh
cp .env.example .env          # FIESTA_NODE=magic  or a list: magic,karar,erda
make up                       # infra + one API + one worker + a frontend per listed node
```

Run `make` for all targets (tests, linting, e2e, rebuild, local dev servers).
Multiple nodes run side by side sharing Postgres/OpenSearch/MinIO — each node
has its own search index, bucket, job queue, and node-scoped contributions,
all served by the single API under `/v1/{node}/...`.

Default ports (one API for every node; one frontend per node):

| Service | Port |
|---|---|
| API (all nodes, docs at `/v1/docs`) | :8000 |
| MagIC frontend | :8080 |
| KdD frontend | :8081 |
| CDR frontend | :8082 |
| KArAr frontend | :8083 |
| ERDA frontend | :8084 |
| OSU-MGR frontend | :8086 |

The API port is `API_PORT` in `.env` (default 8000); the frontends are
`<NODE>_FRONTEND_PORT`. A frontend at `:8080` reaches the API for its node at
`/v1/magic/...`.

- MinIO console: http://localhost:9001 · Mailpit (dev email): http://localhost:8025
- Several nodes under one hostname (`dev.earthref.org/MagIC/`, `/CDR/`, ...): set
  `<NODE>_BASE_PATH=/MagIC/` per node in `.env` — see [development.md](development.md).

Create an account in the UI (or `docker compose run --rm api fiesta
create-user you@example.org "Your Name"`), upload a contribution text file in
the private workspace, validate, publish, and it becomes searchable.

## Layout

```
config/         fiesta.yaml + per-node YAMLs, data models / vocabularies (JSON)
backend/        Python package `fiesta` (the FastAPI app, worker, CLI)
frontend/       SPA (one build serves any node)
docs/api.md     API contract
old-backend/    Legacy Koa/OpenSearch API — reference for porting remaining features
```

See [development.md](development.md) and [deployment.md](deployment.md).

## License

FIESTA is released under the [MIT License](LICENSE).
