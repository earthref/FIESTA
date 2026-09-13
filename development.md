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
make up                   # hot reload: Vite dev server + uvicorn --reload + watchfiles worker
make up PROD=1            # the built images, exactly as CI e2e and a deployment run them
```

`make up` layers `docker-compose.dev.yml` over `docker-compose.yml`: the
backend package is bind-mounted into the image and uvicorn reloads on change,
the worker restarts via `watchfiles`, and each frontend container runs the
Vite dev server (HMR, `<base>v1/` proxied to the API) on the same host
port as the nginx image would. `make up` returns only once every service is
healthy (`--wait`), so the first start blocks for the ~30 s `npm install` into
the empty `node_modules` volume; later starts are ready in about a second.
A `git pull` is therefore live without a rebuild. Two things still need a `make up`: a change to a node YAML (config
loads at startup) and a dependency change (`npm install` runs on container
start; the backend image is rebuilt by `--build`). Frontend `node_modules`
live in a per-node named volume (`node-modules-<node>`), removed by `make clean`.

`FIESTA_NODE` accepts a comma-separated list to run several nodes at once:

```sh
make up FIESTA_NODE=magic,karar,cdr
```

One API (`API_PORT`, default 8000) and one worker serve every listed node;
each node additionally gets its own frontend (compose profiles named after the
node) on its own port (magic 8080, kdd 8081, cdr 8082, karar 8083, erda 8084,
osu-mgr 8086). Infrastructure is shared; isolation comes from a
per-node OpenSearch index, MinIO bucket, procrastinate queue, and a Postgres
schema per node (`magic`, `cdr`, ...) for the workflow tables. Accounts are
shared across nodes (one EarthRef login, in the `public` schema). If your
local database predates the per-node schemas, `make clean` once.

When several nodes run together, `make` cross-links the top portal bar to the
sibling nodes' localhost URLs (it computes `FIESTA_PORTAL_URLS` from the
running node list + frontend ports). Nodes not in `FIESTA_NODE` keep their
production `earthref.org` links. In production this is left empty and the real
hostnames route instead. (Running `docker compose up` directly skips this
computation — use `make up`, or set `FIESTA_PORTAL_URLS=slug=url,...`.)

## Several nodes on one hostname (base paths)

By default each node owns its hostname (or localhost port) and is served at
`/`. To publish several nodes under ONE hostname — `dev.earthref.org/MagIC/`,
`/CDR/`, `/KArAr/`, `/KdD/`, and later `earthref.org/MagIC/` — give each node
a base path in `.env`:

```sh
MAGIC_BASE_PATH=/MagIC/
CDR_BASE_PATH=/CDR/
KARAR_BASE_PATH=/KArAr/
KDD_BASE_PATH=/KdD/
```

The value must start and end with `/`. It is a **build arg** of the frontend
image (asset URLs, the router `basepath`, and the nginx location blocks all
derive from it), so `make up PROD=1` rebuilds the image after a change (the
dev overlay passes it to Vite as `VITE_BASE_PATH`). The single API is not
per-node and is unaffected by base paths: each frontend's nginx proxies
`<base>v1/` to it, so the API's routes stay at `/v1/{node}/...`.

The reverse proxy in front then needs one plain-prefix location per node,
forwarding the full URI (no trailing slash on `proxy_pass`):

```nginx
location /MagIC/ { proxy_pass http://10.10.10.115:8080; }   # frontend-magic
location /CDR/   { proxy_pass http://10.10.10.115:8082; }   # frontend-cdr
```

Everything inside the SPA goes through `siteUrl()` in
`frontend/src/lib/base.ts` (the `api()` helper applies it for you); a new
root-absolute `href` or `fetch("/v1/...")` that bypasses it will break under a
prefix, so route API calls through `api()` / `nodeUrl()` and links through
`siteUrl()`. For a local build outside
Docker, `VITE_BASE_PATH=/MagIC/ npm run build` (or `npm run dev`, which then
serves at `http://localhost:5173/MagIC/`).

## Backend only (against the compose infra)

```sh
docker compose up -d postgres opensearch minio mailpit
cd backend
uv sync
export FIESTA_CONFIG_FILE=../config/fiesta.yaml
export FIESTA_NODE=magic                 # comma-separated list, or unset for all nodes
uv run fiesta init                      # migrations + job schema + bucket + index (per node)
uv run uvicorn fiesta.apps.api:create_app --factory --reload   # http://localhost:8000/v1/docs
uv run fiesta worker                    # in another shell
```

`make backend-dev` / `make worker-dev` wrap the same commands. Point
`FIESTA_CONFIG_FILE` at a single node YAML (e.g. `../config/magic.yaml`) to run
that node as a one-node deployment instead.

Tests and linting:

```sh
uv run pytest
uv run ruff check .
```

## Frontend only

```sh
cd frontend
npm ci
VITE_NODE=magic npm run dev   # http://localhost:5173, proxies /v1 to localhost:8000
npm run lint       # biome
npm run build      # tsc + vite build
```

`VITE_NODE` picks which node's `/v1/{node}` routes the SPA uses. With no
`VITE_API_URL` the SPA calls same-origin `<base>v1/...` and the dev server
proxies it to the API; re-point that proxy with
`VITE_API_TARGET=http://localhost:18000 npm run dev`.

## Adding or changing a node

1. Copy an existing YAML in `config/` and adjust identity, colors, index,
   bucket, hierarchy, levels, facets.
2. Drop the data model JSON(s) in `config/<node>/data_models/{version}.json`
   and vocabularies alongside (the legacy Meteor JS configs convert directly —
   they are plain `export const` objects).
3. Set `FIESTA_NODE=<node>` in `.env` and `docker compose up`.

The config loader validates the YAML on startup (e.g. every `hierarchy` table
must exist in the latest data model).

Home page content is YAML too: `features.home.resources` lists the resource
cards (title, Semantic icon name, optional corner icon, `to` for an SPA route
or `href` for an external URL) and `features.home.news` the news items
(title, HTML body, optional image and link). Images and other files a node's
YAML refers to live in `config/<slug>/assets/` and are served at
`/v1/{node}/config/assets/<path>`. A node with no `resources` gets a default set
(data model, vocabularies, method codes, API, help).

Node-specific features (MagIC poles, CDR depth plots, KArAr age plateaus)
are **plugins** activated per node via `features.plugins` — see
[docs/plugins.md](docs/plugins.md) for the authoring guide.

## CLI

```sh
uv run fiesta init            # migrations, procrastinate schema, bucket, index
uv run fiesta create-user EMAIL NAME [--admin]
uv run fiesta rebuild --yes   # rebuild search from Postgres + revision files
uv run fiesta worker          # run the job worker
```


## Offline Phase M development

`make up FIESTA_NODE=magic,cdr` starts Docker infrastructure, the API, the worker
and a frontend per node. `make seed FIESTA_NODE=magic,cdr` loads the manifests selected by each
node YAML under `development.seed_manifest`. On page load, local development
automatically signs in as Local Developer (`developer@example.test`) once seeded.
Sign-out lasts until the next page refresh. An existing valid login is preserved;
you can sign in as `viewer@example.test`, password `local-fiesta-only`, to test sharing.
Automatic login is disabled outside development mode or with remote infrastructure.
The viewer can read shared
workspace contributions but cannot edit them. Repeated seeds preserve developer
edits and settings. No production credentials, MARFIK, or AWS are needed.

`make test-phase-m` builds and runs all-node seed, revision and migration checks in
an isolated Docker network without external runtime connectivity. Image/dependency
downloads occur during setup. See [Phase M operations](docs/phase-m.md).
