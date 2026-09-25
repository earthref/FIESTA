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
make up ENV_FILE=.env.prod FIESTA_NODE=magic   # local code against that file's Postgres/OpenSearch/S3
```

Without `ENV_FILE` the stack needs no credentials: accounts and data live in the
local containers. With `ENV_FILE`, `docker-compose.remote.yml` points the API at
the Postgres, OpenSearch and S3 named in that file, so login uses the real
EarthRef accounts and the pages show the deployment's contributions. That mode
skips `fiesta init` (this branch's migrations must not run against a shared
database) and starts no worker (it would take the deployment's jobs); uploads
and edits write to the remote. Values in the file are compose-interpolated, so
single-quote a secret containing `$`. `FIESTA_NODE` on the command line beats
the file's.

`make up` layers `docker-compose.dev.yml` over `docker-compose.yml`: the
backend package is bind-mounted into the image and uvicorn reloads on change,
the worker restarts via `watchfiles`, and the frontend container runs the
Vite dev server (HMR, `/v2/` proxied to the API) on the same host port as the
nginx image would. `make up` returns only once every service is healthy
(`--wait`), so the first start blocks for the ~30 s `npm install` into the
empty `node_modules` volume; later starts are ready in about a second.
A `git pull` is therefore live without a rebuild. Two things still need a `make up`: a change to a node YAML (config
loads at startup) and a dependency change (`npm install` runs on container
start; the backend image is rebuilt by `--build`). Frontend `node_modules`
live in a named volume (`node-modules`), removed by `make clean`.

Local S3 is RustFS (console at `http://localhost:9001/rustfs/console/`, login
`fiesta` / `fiesta-secret`). It replaced MinIO in Sept 2026, when MinIO stopped
publishing public images. A stack created before the switch has contribution
files in the old `fiesta_minio-data` volume that RustFS does not read, so run
`make clean && make up` once, then `docker volume rm fiesta_minio-data`, and
rename any `MINIO_*` overrides in `.env` to `RUSTFS_ACCESS_KEY`,
`RUSTFS_SECRET_KEY`, `RUSTFS_API_PORT`, `RUSTFS_CONSOLE_PORT`.

`FIESTA_NODE` accepts a comma-separated list to run several nodes at once:

```sh
make up FIESTA_NODE=magic,karar,cdr
```

One API (`API_PORT`, default 8000), one worker and one frontend
(`FRONTEND_PORT`, default 8080) serve every listed node. The frontend
publishes each node under its key — `http://localhost:8080/MagIC/`,
`/KArAr/`, `/CDR/` (any case works) — the layout `earthref.org/MagIC/` uses,
and sends `http://localhost:8080/` (or any path outside a node prefix) to the
same path under the first listed node. Infrastructure is shared; isolation
comes from a per-node OpenSearch index, S3 prefix, procrastinate queue, and
a Postgres schema per node (`magic`, `cdr`, ...) for the workflow tables.
Accounts are shared across nodes (one EarthRef login, in the `public`
schema). If your local database predates the per-node schemas, `make clean`
once.

The top portal bar links every node in `FIESTA_NODE` to this frontend
(`http://localhost:8080/CDR`) and every other node to its production
`earthref.org` URL: compose passes the frontend's origin to the API as
`FIESTA_FRONTEND_URL`, and the config route turns it into `portal_urls` for
the nodes it serves. In production this is left empty and the real hostnames
route instead.

## Base paths and the multi-node layout

The SPA is built for one **build base** — Vite's `base`, `/` by default —
where its assets, `fiesta-env.js` and the `/v2/` proxy live, and runs its
routes under a **base path**. Two layouts:

- **One node per build.** The base path is the build base. `BASE_PATH=/MagIC/`
  (a build arg of the frontend image; `VITE_BASE_PATH` for a build outside
  Docker) publishes a single node under a prefix, which is how
  `deploy-fiesta.sh` builds one static bundle per node for
  `earthref.org/MagIC/`, `/KdD/`, … The value must start and end with `/`,
  and the nginx location blocks derive from it, so a change means a rebuild.
- **Every node on one origin.** The build sits at `/` and `fiesta-env.js`
  lists the served nodes (`FIESTA_NODES=magic,cdr` on the nginx image or the
  Vite dev server; compose sets it from `FIESTA_NODE`). The first path segment
  then picks the node and becomes the base path at load time, so one
  container serves `/MagIC/`, `/CDR/`, … This is what `make up` runs, and a
  reverse proxy that forwards a whole hostname to it (`location / {
  proxy_pass http://10.10.10.115:8080; }`) gives the `dev.earthref.org/MagIC/`
  shape without per-node images.

The single API is unaffected by either: nginx or the Vite proxy forwards
`<build base>v2/` to it, so its routes stay at `/v2/{node}/...`.

Everything inside the SPA goes through `frontend/src/lib/base.ts`: `siteUrl()`
for links into this node (the `api()` helper and the router apply it for
you), `assetUrl()` for files from `public/`, `apiUrl()` / `nodeUrl()` for the
API. A new root-absolute `href` or `fetch("/v2/...")` that bypasses them will
break under a prefix. For a build outside Docker, `VITE_BASE_PATH=/MagIC/
npm run build` builds one node under a prefix; `make frontend-dev` (or
`FIESTA_NODES=magic,cdr npm run dev`) serves the multi-node layout at
`http://localhost:5173/MagIC/`.

## Backend only (against the compose infra)

```sh
docker compose up -d postgres opensearch rustfs mailpit
cd backend
uv sync
export FIESTA_CONFIG_FILE=../config/fiesta.yaml
export FIESTA_NODE=magic                 # comma-separated list, or unset for all nodes
uv run fiesta init                      # migrations + job schema + bucket + index (per node)
uv run uvicorn fiesta.apps.api:create_app --factory --reload   # http://localhost:8000/v2/docs
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
VITE_NODE=magic npm run dev   # http://localhost:5173, proxies /v2 to localhost:8000
npm run lint       # biome
npm run build      # tsc + vite build
```

`VITE_NODE` picks which node's `/v2/{node}` routes the SPA uses. With no
`VITE_API_URL` the SPA calls same-origin `<base>v2/...` and the dev server
proxies it to the API; re-point that proxy with
`VITE_API_TARGET=http://localhost:18000 npm run dev`.

## Adding or changing a node

A node is configuration: `config/<slug>.yaml` plus `config/<slug>/**`. There
are two ways to change it, and both end up in both places:

- **Admin UI** (`/<Key>/admin`, super admins and node admins). Edits go into
  a draft in Postgres. Publishing validates the draft, serves it at once and
  writes the files to the repository: in production a PR from
  `node-config/<slug>`; locally, with `FIESTA_CONFIG_PUBLISH=files` (the
  compose dev overlay sets it), straight into your checkout's `config/`, to
  commit like any other change. A new node is created there too, copied from
  a template node. Its first publication creates its schema, index and prefix.
- **Git**, as before:
  1. Copy an existing YAML in `config/` and adjust identity, colors, index,
     bucket, hierarchy, levels, facets.
  2. Drop the data model JSON(s) in `config/<node>/data_models/{version}.json`
     and vocabularies alongside (the legacy Meteor JS configs convert directly —
     they are plain `export const` objects).
  3. Set `FIESTA_NODE=<node>` in `.env` and `docker compose up`. `fiesta init`
     imports any tree Postgres has not published before, so the change goes
     live on the next deploy.

The config loader validates the YAML on startup and before any publication
(e.g. every `hierarchy` table must exist in the latest data model). To run
this checkout's YAML against a database whose published config differs, set
`FIESTA_NODE_CONFIG_SOURCE=files`.

Grant yourself admin rights locally with `fiesta create-user EMAIL NAME --admin`
(super admin); super admins grant node admins in the UI.

Home page content is YAML too: `features.home.resources` lists the resource
cards (title, Semantic icon name, optional corner icon, `to` for an SPA route
or `href` for an external URL) and `features.home.news` the news items
(title, HTML body, optional image and link). Images and other files a node's
YAML refers to live in `config/<slug>/assets/` and are served at
`/v2/{node}/config/assets/<path>`. A node with no `resources` gets a default set
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
