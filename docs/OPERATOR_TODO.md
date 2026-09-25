# Operator TODO

The one place for actions only a human can do: credentials, money, DNS, vendor
registrations, production access, and product judgement calls. A "you'll need to
set X" said in chat and not written here is lost by the next session.
Maintained by `/operator-todo`. Never put a secret VALUE here, only its name.

Last updated: 2026-09-24

## A — Decisions

- [ ] **Approve Phase A (one FIESTA API).** Confirms: node in the path
      (`/v2/{node}/...`), `/api` folds into `/v2`, SPA talks to the API directly,
      SPA node comes from `FIESTA_NODE`. Then Claude starts A1 on a worktree branch.
      Unblocks: ROADMAP Phase A, B1, B3.
- [ ] **Hosting for the FIESTA API and frontends** (where, who pays, how deploys
      run). Unblocks: ROADMAP E1, B2.
- [ ] **Cutover shape**: `dev.earthref.org/<Node>/` first, then `earthref.org/<Node>/`
      as a proxy change (deployment.md) — confirm or change. Unblocks: E4.
- [ ] **KdD legacy ownership.** 256 of 264 KdD contributions were bulk-loaded with only
      the display name "Roger Nielsen" and no handle; the shared user index has one
      matching account (`rnielsen`, nielsenr@geo.oregonstate.edu). Approve adding
      `owner_names: {"Roger Nielsen": nielsenr@geo.oregonstate.edu}` to `config/kdd.yaml`
      so all 264 import; otherwise only the 8 with handles do. Unblocks: KdD import (M5).
- [ ] **Which CDR is real.** Legacy has `cdr` (alias of `cdr-2`: 58 contributions, data
      model 1.0, what the private workspace writes to; matches FIESTA's CDR config) and
      `cdr-3` (665 contributions, model 3.0, bulk-loaded 2025-09-16; the checked-out search
      page defaults to it). Ids overlap with different content, and FIESTA has no CDR 3.0
      data model. Choose one; `cdr-3` first needs the 3.0 model converted from the legacy
      repo. CDR has no S3 buckets, so every record exports from the index. Unblocks: CDR import (M5).
- [ ] **MagIC contributions with no owner account.** 40 legacy handles (66 contributions)
      match no `er_users` account — deleted account ids such as `user8928` (11 records) and
      `user10068` (4), plus two records with the literal handle `undefined`. Map them with
      `owner_overrides` / `owner_names` / `default_owner` in `config/magic.yaml`, or leave
      them out; a re-run of the sync picks them up incrementally. The list with ids is
      produced by `legacy-inventory` (report `errors`). Unblocks: nothing; parity only.

## B — Credentials and access (names only)

- [ ] Production Postgres, OpenSearch, and S3 access for the FIESTA API host:
      `FIESTA_DATABASE_URL`, `FIESTA_OPENSEARCH_URL`, `FIESTA_INDEX_PREFIX` (must be
      set on the shared cluster), `FIESTA_S3_BUCKET` + `FIESTA_S3_ACCESS_KEY` /
      `FIESTA_S3_SECRET_KEY` (IAM user scoped to that bucket), `FIESTA_SECRET_KEY`,
      `FIESTA_SMTP_*`. Unblocks: E1, E2.
- [ ] **CORS on the live API** must allow the Vite dev origin (`http://localhost:5173`)
      so frontend contributors can log in from a local SPA (`FIESTA_CORS_ORIGINS`).
      Safe with bearer tokens and no cookies. Unblocks: B2.
- [ ] **EZID account** for DOI minting (username/password names TBD when C1 is built).
      Unblocks: C1 live path.
- [ ] **ORCID API client** (client id/secret, redirect URI per host). Unblocks: C2.

## C — Data

- [x] **Where do the existing contributions live** (files + metadata) and may Claude
      read them to size the import (E2)? — Answered 2026-09-14: legacy OpenSearch index
      `<slug>` + `er_users` on the MARFIK cluster and `<slug>-activated-contributions` /
      `<slug>-contributions` buckets; credentials in `.env.prod`, used via `make fiesta ENV_FILE=`.
- [ ] **Copy EarthRef logins into FIESTA** (2026-09-24): legacy accounts were imported
      without passwords, so every EarthRef login fails. Dry run, then apply:
      `make fiesta ENV_FILE=.env.prod ARGS="sync-legacy-users magic"` and again with
      `--apply`. Re-run until cutover to pick up legacy password changes (legacy wins).

## 2026-09-11 — MARFIK legacy app deploys

- [ ] **Fix the deploy checkout permissions on MARFIK and re-run the four Deploy
      workflows.** Every `main` push on 2026-09-11 failed inside
      `/home/earthref/bin/deploy-app.sh` at "fetching origin/main": MagIC with
      `insufficient permission for adding an object to repository database
      .git/objects`, CDR/KArAr/KdD with `unable to append to
      '.git/logs/refs/remotes/origin/main': Permission denied`. The runs from
      2026-09-10 22:18 UTC succeeded, so something since then wrote to those
      long-lived checkouts as a different user (a manual `git fetch`/`pull` as
      root or earthref, most likely). On the host: `chown -R` each app checkout
      back to the runner's user, then re-run the failed `Deploy` runs from the
      Actions tab (MagIC 34620748778, CDR 34621097555, KArAr 34621148511, KDD
      34621202148) or push an empty commit. Unblocks: the `assetUrl` fix (MagIC
      #598 and the matching commits on the other three repos) that makes the
      About/news/technology images, FIESTA header logo and ORCID icon render
      under the `/MagIC` (etc.) path prefix. After: Claude checks the four
      sites' About pages and closes this item.

## 2026-09-12 — Phase A one-API deploy script

- [ ] **Update the production deploy script for the one FIESTA API.**
      `/srv/fiesta/bin/deploy-fiesta.sh` on the `fiesta-ct` runner (not in this
      repo) still starts a per-node uvicorn process and proxies `/api`. Phase A
      is now one process: change it to run a single
      `uvicorn fiesta.apps.api:create_app` with
      `FIESTA_CONFIG_FILE=config/fiesta.yaml` (optionally `FIESTA_NODE` to narrow
      the set), proxy `<base>v1/` to that process instead of `/api`, and build
      each node's SPA with `VITE_NODE=<slug>` (or serve `fiesta-env.js` per node)
      so each frontend resolves its node and API origin. See deployment.md,
      "The production deploy script". Unblocks: E1 rollout on the current host.

## 2026-09-24 — Admin settings (super admins, node admins, node editing)

- [ ] **GitHub token for node publications.** Create a fine-grained token with
      Contents + Pull requests write on `earthref/FIESTA`, and set
      `FIESTA_GITHUB_TOKEN` and `FIESTA_CONFIG_PUBLISH=github` in the production
      API **and** worker env (the worker opens the PR). Optionally turn on "Allow
      auto-merge" in the repository settings and set `FIESTA_GITHUB_AUTO_MERGE=true`.
      Until this is done, publications still go live, but their revisions show
      "not written to git" and `config/` falls behind the live nodes. After: Claude
      publishes a no-op settings change on one node and checks that the
      `node-config/<slug>` PR opens with the `internal` label.
- [ ] **Name the first super admin(s) on production.** Either `fiesta create-user
      EMAIL NAME --admin` on the API host, or set `users.is_admin = true` for an
      existing EarthRef account. Super admins then grant node admins in `/<Key>/admin`.
      Product call: who gets super admin and who administers each node.
- [ ] **Deploy script, in addition to the 2026-09-12 item:** keep running `fiesta init`
      on every deploy (it imports `config/` into Postgres and brings up nodes created
      in the UI), and run the worker **without** `FIESTA_NODE` so it listens on every
      queue, including queues of nodes published later. The script still builds one
      SPA per node listed in `config/fiesta.yaml`, so a node created in the UI appears
      on the website only after its PR is merged and deployed.

## Done

_(none yet)_
## Phase M — live migration and recovery gates

- [ ] Supply and verify each node's full source inventory (public/private buckets,
      pipeline indices, metadata export contracts, available historical objects,
      attachment keys and deletion markers). Review ownership/account mappings and
      DOI/version links; approve explicit exceptions for unavailable history.
- [ ] Provide scoped legacy source-read and FIESTA destination-write credentials
      through environment/secret management. Confirm production bucket Versioning
      and retention preserve every retained revision and its processing artifacts.
- [ ] Set Postgres backup/WAL archive destinations, retention, RPO/RTO, matching
      object retention and application-image retention. Rehearse an isolated full
      restore with `fiesta verify-storage`, rebuild and outbox replay.
- [ ] Size full-inventory imports and allowed-ID search filters on a production-sized
      rehearsal; set batch sizes and operational limits before enabling live traffic.
- [ ] Approve per-node write freeze, final sync/reconciliation, traffic switch and
      rollback window. Disable legacy sync at cutover; preserve new FIESTA revisions
      if rolling back after accepting writes. See [phase-m.md](phase-m.md).
