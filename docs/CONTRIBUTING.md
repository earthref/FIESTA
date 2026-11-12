# Contributing to FIESTA

FIESTA is the platform behind the EarthRef.org data repositories (MagIC, KdD,
CDR, KArAr, ERDA, OSU-MGR, SC). You develop against a complete local copy of
it: Docker containers for Postgres, OpenSearch, S3 (RustFS) and email
(Mailpit), plus checked-in seed data for every node. You need no MARFIK, AWS or
production credentials and no EarthRef account, and nothing you do locally can
reach the live repositories.

## Get it running

You need Docker with Compose and `make`. For running the backend or frontend
outside Docker you also need [uv](https://docs.astral.sh/uv/) and Node 22
(`nvm use` reads `.nvmrc`).

```sh
git clone https://github.com/<you>/FIESTA.git     # your fork
cd FIESTA
make up        # every node; `make up FIESTA_NODE=magic,cdr` for fewer (faster)
```

`make up` starts the stack, then seeds it: demo accounts, private drafts and
each node's 50 newest public contributions from dev.earthref.org (later starts
fetch only what dev published since). The first `make up` builds images and
downloads the data, so it takes a few minutes; later starts take seconds.
`make up SEED=0` skips the seed (offline work); `make seed` runs it on its own. Then:

| | |
|---|---|
| Frontend (every node under its key) | http://localhost:8080/MagIC/, `/CDR/`, `/KArAr/`, … |
| API and its docs | http://localhost:8000/v2/docs |
| Email sent by the stack | http://localhost:8025 (Mailpit) |

The page signs you in as **Local Developer** (`developer@example.test`, a super
admin, so `/admin` works). `viewer@example.test` is a second account for
testing sharing; both use the password `local-fiesta-only`. Each node has a
private draft with revision history, an invalid draft and its 50 most recent
public contributions from dev.earthref.org (`make seed ARGS=--fixtures` loads
hand-made public examples instead, offline). `make import-public NODE=magic
IDS="20818"` copies particular public contributions.

If a port is already taken on your machine, copy `.env.example` to `.env` and
move it (`API_PORT`, `FRONTEND_PORT`, `POSTGRES_PORT`, …).

`make up` runs with hot reload: edits under `fiesta/backend/fiesta/` and
`fiesta/frontend/src/` are live. A change to a node YAML or a dependency needs another
`make up`. `make down` stops the stack; `make clean` also deletes its data,
and `make up` starts over. [development.md](development.md) covers
running the API, worker or frontend on the host and everything else.

## Before you change things

Read the "Hard Rules" in [CLAUDE.md](../CLAUDE.md): they are the project's rules,
written down for people and coding agents alike. The ones that most often
matter:

- **A node is configuration, not a code branch.** Node-specific identity,
  vocabularies, data models and features live in `configurations/<node>.yaml` and
  `configurations/<node>/`. Never write `if node == "magic"` in core code.
- **Node-specific science is a plugin**, one folder per plugin with its
  backend, UI, tests and docs (`configurations/plugins/<name>/`); see
  [plugins.md](plugins.md).
- **`/v1` is a frozen legacy API.** New endpoints go under `/v2`; see
  [api.md](api.md).
- **Legacy UI behaviour is a spec** ([legacy-ux-spec.md](legacy-ux-spec.md)).
  Deviations are decisions recorded there, not accidents.
- **`old-backend/` is read-only reference.**
- **Seed data is synthetic or redistributable public data.** Never commit
  production data, private contributions or credentials.

## Check your work

```sh
make lint      # ruff + biome   (make fix auto-fixes)
make test      # backend pytest + frontend type-check and build
make e2e       # the upload → validate → publish → search workflow, against `make up FIESTA_NODE=magic PROD=1`
```

CI runs all of these plus the offline seed and migration checks
(`make test-integration`), so a green CI means they passed.

## Pull requests

1. Work on a branch in your fork and open a PR against `main`.
2. Give the PR exactly one label: `feature`, `bug`, `refactor`, `upgrade`,
   `docs`, `internal`, `security` or `breaking`. If you can't add labels, a
   maintainer will. The `check-labels` check fails until there is one.
3. CI on a fork's PR waits until a maintainer approves the run.
4. A maintainer reviews it. `main` requires an approving review and a green
   `CI` check.

A merge to `main` deploys to dev.earthref.org and runs that deployment's
database migrations, so changes under `fiesta/backend/alembic/` and `.github/` get
the closest review. Migrations must work once per node schema; see the
multi-node notes in [CLAUDE.md](../CLAUDE.md) before writing one.

## Questions and security

Open an issue for bugs, questions and ideas. Report security vulnerabilities
privately through
[GitHub's vulnerability reporting](https://github.com/earthref/FIESTA/security/advisories/new),
never in a public issue.
