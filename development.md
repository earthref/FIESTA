# FIESTA - Development

Most workflows are wrapped in the root [Makefile](Makefile) — run `make` to
list targets (`make up`, `make test`, `make lint`, `make e2e`, `make rebuild`,
`make backend-dev`, `make frontend-dev`, ...). The sections below show what
each wraps.

## Prerequisites

- Docker + Docker Compose (for the full stack)
- [uv](https://docs.astral.sh/uv/) (backend), Node 22 + npm (frontend — `.nvmrc`
  is provided, so `nvm use` in the repo root selects the right version)

## Full stack

```sh
cp .env.example .env      # FIESTA_NODE selects the node(s); ports overridable
make up                   # or: docker compose up --build (honors COMPOSE_PROFILES)
```

`FIESTA_NODE` accepts a comma-separated list to run several nodes at once:

```sh
make up FIESTA_NODE=magic,karar,cdr
```

Each node gets its own backend/worker/frontend (compose profiles named after
the node) with per-node default ports (magic 8000/8080, kdd 8001/8081, cdr
8002/8082, karar 8003/8083, erda 8004/8084). Infrastructure is shared; isolation comes from a
per-node OpenSearch index, MinIO bucket, procrastinate queue, and a `node`
column scoping contributions in Postgres. Accounts are shared across nodes
(one EarthRef login).

When several nodes run together, `make` cross-links the top portal bar to the
sibling nodes' localhost URLs (it computes `FIESTA_PORTAL_URLS` from the
running node list + frontend ports). Nodes not in `FIESTA_NODE` keep their
production `earthref.org` links. In production this is left empty and the real
hostnames route instead. (Running `docker compose up` directly skips this
computation — use `make up`, or set `FIESTA_PORTAL_URLS=slug=url,...`.)

## Backend only (against the compose infra)

```sh
docker compose up -d postgres opensearch minio mailpit
cd backend
uv sync
export FIESTA_CONFIG_FILE=../config/magic.yaml
uv run fiesta init                      # migrations + job schema + bucket + index
uv run uvicorn fiesta.apps.node:create_app --factory --reload   # http://localhost:8000
uv run fiesta worker                    # in another shell
```

Tests and linting:

```sh
uv run pytest
uv run ruff check .
```

The public API instead: `uv run uvicorn fiesta.apps.public:create_app --factory`
with `FIESTA_CONFIG_FILE=../config/public-api.yaml`.

## Frontend only

```sh
cd frontend
npm ci
npm run dev        # http://localhost:5173, proxies /api to localhost:8000
npm run lint       # biome
npm run build      # tsc + vite build
```

Point the proxy elsewhere with `VITE_API_TARGET=http://localhost:18000 npm run dev`.

## Adding or changing a node

1. Copy an existing YAML in `config/` and adjust identity, colors, index,
   bucket, hierarchy, levels, facets.
2. Drop the data model JSON(s) in `config/<node>/data_models/{version}.json`
   and vocabularies alongside (the legacy Meteor JS configs convert directly —
   they are plain `export const` objects).
3. Set `FIESTA_NODE=<node>` in `.env` and `docker compose up`.

The config loader validates the YAML on startup (e.g. every `hierarchy` table
must exist in the latest data model).

Node-specific features (MagIC poles, CDR depth plots, KArAr age plateaus)
are **plugins** activated per node via `features.plugins` — see
[docs/plugins.md](docs/plugins.md) for the authoring guide.

## CLI

```sh
uv run fiesta init            # migrations, procrastinate schema, bucket, index
uv run fiesta create-user EMAIL NAME [--admin]
uv run fiesta rebuild --yes   # regenerate Postgres + OpenSearch from the bucket
uv run fiesta worker          # run the job worker
```
