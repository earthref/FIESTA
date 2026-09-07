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
and enabled features. Deploying a different node (or the public API) means
pointing at a different YAML file.

## Architecture

```
frontend    Vite + React + TanStack Router/Query SPA (branding fetched from /api/config)
backend     FastAPI + SQLAlchemy (async) + asyncpg + Pydantic v2 + Alembic  →  /api
public-api  Same codebase, public /v1 REST surface across all nodes (api.earthref.org)
worker      procrastinate (Postgres-native jobs): parse/validate/summarize/index, email
postgres    Accounts + contribution workflow state (Postgres 16)
opensearch  Denormalized search documents, one index per node
minio       S3-compatible storage: canonical contribution files + manifests
```

**Reproducibility:** the storage bucket (canonical files + `manifest.json` per
contribution) plus the YAML config are the durable record of a node. Postgres
and OpenSearch are projections — `fiesta rebuild` regenerates both from the
bucket.

## Quick start

```sh
cp .env.example .env          # FIESTA_NODE=magic  or a list: magic,karar,erda
make up                       # one backend+worker+frontend per listed node
```

Run `make` for all targets (tests, linting, e2e, rebuild, local dev servers).
Multiple nodes run side by side sharing Postgres/OpenSearch/MinIO — each node
has its own search index, bucket, job queue, and node-scoped contributions.

Default ports per node (frontend / backend API docs at `/api/docs`):

| Node | Frontend | Backend |
|---|---|---|
| MagIC | :8080 | :8000 |
| KdD | :8081 | :8001 |
| CDR | :8082 | :8002 |
| KArAr | :8083 | :8003 |
| ERDA | :8084 | :8004 |
| OSU-MGR | :8086 | :8006 |

- MinIO console: http://localhost:9001 · Mailpit (dev email): http://localhost:8025
- Several nodes under one hostname (`dev.earthref.org/MagIC/`, `/CDR/`, ...): set
  `<NODE>_BASE_PATH=/MagIC/` per node in `.env` — see [development.md](development.md).
- Public API (all nodes): `make up-public-api` → http://localhost:8005/v1/docs

Create an account in the UI (or `docker compose run --rm backend fiesta
create-user you@example.org "Your Name"`), upload a contribution text file in
the private workspace, validate, publish, and it becomes searchable.

## Layout

```
config/         Deployment YAMLs + per-node data models / vocabularies (JSON)
backend/        Python package `fiesta` (both FastAPI apps, worker, CLI)
frontend/       SPA (one build serves any node)
docs/api.md     API contract
old-backend/    Legacy Koa/OpenSearch API — reference for porting remaining features
```

See [development.md](development.md) and [deployment.md](deployment.md).

## License

FIESTA is released under the [MIT License](LICENSE).
