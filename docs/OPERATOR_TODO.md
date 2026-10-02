# Operator TODO

The one place for actions only a human can do: credentials, money, DNS, vendor
registrations, production access, and product judgement calls. A "you'll need to
set X" said in chat and not written here is lost by the next session.
Maintained by `/operator-todo`. Never put a secret VALUE here, only its name.

Last updated: 2026-10-01

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
      matching account (`rnielsen`). Approve mapping it with
      `{"owner_names": {"Roger Nielsen": "<that account's email>"}}` in the gitignored
      `migration/kdd/owner_map.json` (`legacy-inventory --owner-map`; owner emails never
      go in checked-in config) so all 264 import; otherwise only the 8 with handles do.
      Unblocks: KdD import (M5).
- [x] **Which CDR is real.** Decided 2026-09-28: import `cdr-3` only (665 contributions,
      bulk-loaded 2025-09-16, what the legacy search page shows). The 58 contributions in
      the `cdr` alias (`cdr-2`, model 1.0, ids overlapping with different content) are left
      behind. No CDR 3.0 model exists anywhere, so FIESTA CDR stays at 1.0: `1.0.json` is
      extended with every table and column cdr-3 carries (only `sections.label` was
      missing), and `legacy.data_model_version: "1.0"` in `config/cdr.yaml` imports every
      record as 1.0. CDR has no S3 buckets, so every record exports from the index. The
      contributor handle on every cdr-3 record is `cdr` (no account); decided 2026-09-29
      they go to the OSU-MGR steward account via `owner_handles` in the gitignored
      `migration/cdr/owner_map.json`. Unblocks: CDR import (M5).
- [ ] **CDR: the 665 cdr-3 contributions import invalid against 1.0** (decided
      2026-09-29: import as is; 1.0's `required()` and longitude rules unchanged). The
      2025 bulk load never filled required values: `measurements.experiment`, `quality`,
      `method_codes`, `citations` (all 309,650 rows); `sections.type` (2,769 rows);
      `contribution.lab_names` (665); `cores.method` (664). 561 cores give longitude
      as −180..180 where 1.0 allows 0..360; contribution 88 has no `lat`/`lon`. Decide
      per cause: fill values (a new version of each contribution), relax the rule in the
      model, or leave them flagged. Unblocks: nothing; CDR data quality only.
- [ ] **MagIC contributions with no owner account.** 40 legacy handles (66 contributions)
      match no `er_users` account — deleted account ids such as `user8928` (11 records) and
      `user10068` (4), plus two records with the literal handle `undefined`. Map them with
      `owner_overrides` / `owner_names` / `default_owner` in `config/magic.yaml`, or leave
      them out; a re-run of the sync picks them up incrementally. The list with ids is
      produced by `legacy-inventory` (report `errors`). Unblocks: nothing; parity only.
- [ ] **ERDA legacy import: apply** (decisions made 2026-09-29: a steward account,
      kept with every owner email in the gitignored `migration/erda/owner_map.json`;
      deferred and lost-file records metadata only; test record 2741 excluded; details
      in `docs/erda-node.md` "Legacy import"; output in the ERDA import worktree's
      `migration/erda/`). Re-run `legacy-inventory erda … --max-file-mb 100 --owner-map
      ../migration/erda/owner_map.json` (reuses the page/file caches; check the report
      has no `default_owner … not in er_users` error), review `owner_mapping.json` (198 names by exact full name; 21
      unmatched names → steward, 319 records), then `fiesta init` for `erda` on dev (the
      schema does not exist there yet), `ensure-owners … --apply`, `sync-legacy … --apply`,
      and drain the outbox. Unblocks: ERDA import (M5).
- [ ] **ERDA large files into S3** (after the apply above). 258 records were imported
      metadata only because their files are listed over 100 MiB; the record/file list is
      `migration/erda/excluded.json` → `deferred` (329 files). Their listed sizes are
      unreliable: records 1601–1706 (stereo field images) list sizes 1024× too large, so
      the real total is ≈122 GB, not the listed ~76 TB, and 13 TIFFs there are really
      2–3.3 GB — over `legacy.max_file_bytes` (2 GiB) and read whole into memory by
      `sync-legacy`, so raise that limit on a host with the RAM, or leave those 13 on the
      legacy site. To transfer: re-run `legacy-inventory erda --max-file-mb 0
      --max-total-gb 150` (downloads only what is not cached) and `sync-legacy --apply`
      (adds a revision with the files to each record). The 151 `legacy_missing` records
      (149 `10.58052/…` "ArArCALC ERDA Uploader" argon uploads, plus 806 and 1842) have
      no files anywhere we know of; they stay metadata only unless the originals turn up.

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
- [ ] (Optional, 2026-09-27) Grant the OpenSearch `fiesta` role
      `indices:data/read/scroll/clear`. The search map scrolls its points and the role
      may not clear a scroll (403). The API now ignores that, and each context expires
      after 1 minute, so the map works without it; the grant only frees contexts sooner.

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

## 2026-09-28 — Geospatial filter across levels

- [ ] **Rebuild each node's search index once this is deployed** (`fiesta rebuild
  --yes` per node, on dev and production). Search docs now get a position on
  every level (a specimen takes its sample's) and contribution docs carry all
  of their rows' positions. Until the rebuild, the area filter drops the
  levels without coordinates (specimens, measurements, ...) and matches a
  contribution by its first position only.

## 2026-09-30 — Locations mapped at their sites, no boxes

- [ ] **Rebuild MagIC's and OSU-MGR's search indexes once this is deployed**
  (`fiesta rebuild --yes`, dev and production; the dev rebuild below covers
  it if it runs after this deploy). A location (or cruise) doc's `_geo_point`
  becomes its sites' and samples' (cores', dives') positions, and the maps no
  longer draw boxes. Until the rebuild, a location is a single point at its
  box's centre, which is on the far side of the world when its `lon_w` and
  `lon_e` are swapped.

## 2026-09-30 — Lunar and Martian globes

- [ ] **Rebuild the dev search indexes** (`make fiesta ENV_FILE=.env.prod
  NODE=<slug> ARGS="rebuild --yes"` for karar, kdd, cdr, osu-mgr, erda, magic;
  this also covers the 2026-09-28 item above). The code and the node config
  (`search.bodies`) reached dev with the 2026-09-30 08:27 UTC deploy, and
  `fiesta init` on dev reported the config already imported; but the index
  still has the 7 Lunar MagIC locations (20329, 20328 ×3, 19955, 19781, 12366)
  in `_geo_point`, so they are drawn on Earth until the rebuild. Claude's
  attempt was blocked by the auto-mode classifier. The Moon/Mars basemaps are
  public services (OpenPlanetaryMap on CARTO, NASA Solar System Treks, USGS
  Astrogeology WMS) with no key; dev already serves `/v2/basemap/moon`.

## 2026-09-28 — Reference enrichment (Crossref/DataCite)

- [ ] **Run `fiesta worker` as a service on fiesta-ct** (blocker for everything
      after an upload: parsing, validation, indexing, and now reference metadata).
      The deploy script swaps the release and restarts the API only; nothing starts
      the worker, so dev has been drained by hand from a laptop. A systemd unit
      beside the API's, restarted by `deploy-fiesta.sh` after `fiesta init`:
      `ExecStart=/srv/fiesta/current/backend/.venv/bin/fiesta worker`,
      `WorkingDirectory=/srv/fiesta/current/backend`, the API's `EnvironmentFile`,
      `FIESTA_CONFIG_FILE=../config/fiesta.yaml`, no `FIESTA_NODE` (every node's
      queue plus `default`; since 2026-10-01 never `ops`, which belongs to the
      MARFIK3 ops worker, and a node published in the admin UI is picked up by an
      in-process restart, not by listening on all queues), `Restart=always`
      (paths as the API's unit has them; these are inferred from the release
      layout, not read off the host). It starts the outbox poller itself.
- [ ] **Allow outbound HTTPS from the worker host** to `api.crossref.org` and
      `api.datacite.org`. Crossref's polite pool identifies us by
      `FIESTA_SMTP_FROM`; set it to an address someone reads if Crossref ever
      needs to reach us.

## 2026-09-28 — MapLibre poles view and Rock Magnetism view

- [ ] **Rebuild MagIC's search index once this is deployed** (`fiesta rebuild
  --yes` for magic, on dev and production; one rebuild also covers the item
  above). The `rock-mag` plugin's `rock_mag` docs exist only for contributions
  processed after deploy until then, so the home page's Rock Magnetism card
  opens an empty view.
- [ ] **Rebuild every node's search index after the records-and-rows change**
  (`fiesta rebuild --yes` per node, dev and production; covers the two rebuild
  items above). A level's rows sharing a name are now one doc, so Summaries
  counts records and Rows their rows. Until the rebuild, old one-row docs
  show Summaries = Rows, and the Rock Magnetism view says nothing is indexed.
- [ ] **Check the Rock Magnetism view against real use** with a rock magnetist
  (e.g. on dev after the rebuild): the panel set, and the rule that reads a
  contribution's coercivities/MDFs as mT when their median is above 1 T.

## 2026-09-28 — interactive PmagPy plots (`pmag-plots`)

- [ ] **Rebuild MagIC's search index once this is deployed** (`fiesta rebuild
  --yes` for magic, dev and production; one rebuild covers the items above).
  The contribution modal's plot tabs are counted from `pmag_plots` docs, which
  exist only for contributions processed after deploy until then, so older
  contributions show no plot tabs.
- [ ] **Have a paleomagnetist look over the plot tabs** on dev after the
  rebuild (Zijderveld axis convention, Arai pTRM-check drawing, which levels
  Equal Area offers), and choose what comes next: VGP Map and Anisotropy
  (the other legacy plot types), plots in the search view across
  contributions, or PmagPy itself on the backend for interpretation
  statistics (it would add matplotlib, pandas and scipy to the API).

## 2026-09-30 — Seamount Catalog (SC) node

- [ ] **Import the catalog on production.** Pick the steward account the 33
  region contributions belong to (the legacy pages name no contributors), then
  `python3 scripts/sc-legacy-catalog.py --cache ../migration/sc/pages
  --inventory ../migration/sc --owner <steward email>` and `make fiesta
  ENV_FILE=.env.prod NODE=sc ARGS="sync-legacy ../migration/sc/inventory.json"`
  (add `--apply` once the dry run reads right). See `docs/sc-node.md`.
- [ ] **Find the map images and grids.** They were served from
  `erda.sdsc.edu/maps/<area>/{JPG,GRD}/` (404 now) and earthref.org answers the
  same paths with HTML. If they survive on MARFIK or an SDSC backup, say where;
  the SC `maps` rows carry each file's name and legacy file id to attach them by.
- [ ] **Decide when FIESTA serves `/SC/`.** `publish.web` is false in
  `config/sc.yaml` because the legacy CGI catalog still answers at
  `earthref.org/SC/`; flip it at that node's cutover.

## 2026-10-01 — Scheduled operations on MARFIK3

`fiesta ops-worker` runs the jobs in `config/ops/schedules.yaml` (first:
`osu-mgr-incremental`, daily 10:00 UTC) and posts ✅/❌ to the MARFIK monitor
channel; see [ops-scheduler.md](ops-scheduler.md). Nothing runs until these are
done. Paths below (`/srv/fiesta-ops`, `/etc/fiesta`, user `fiesta`) are
suggestions; keep whatever MARFIK3 already uses and adjust the units to match.

- [ ] **Create the Slack app in the EarthRef workspace.** api.slack.com/apps →
      Create New App (from scratch) in the EarthRef workspace, e.g. "FIESTA ops";
      OAuth & Permissions → Bot Token Scopes: `chat:write` only; Install to
      Workspace; copy the Bot User OAuth Token (`xoxb-…`). In the EarthRef
      workspace's MARFIK monitor channel run `/invite @FIESTA ops` (without the
      invite every post fails with `not_in_channel`, which the ops worker logs).
      Put the channel's ID (channel details → bottom of the About tab, `C…`) in
      `config/ops/schedules.yaml` as `slack.channel` via a PR; until then the
      worker only logs its messages. Secret name: `FIESTA_SLACK_BOT_TOKEN`.
- [ ] **Check out and sync FIESTA on MARFIK3** (the ops worker reads
      `config/ops/schedules.yaml` and `config/fiesta.yaml` from it):
      `git clone https://github.com/earthref/FIESTA /srv/fiesta-ops/FIESTA`,
      then `cd /srv/fiesta-ops/FIESTA/backend && uv sync --frozen`. Nothing
      deploys it yet: after a merge that changes `backend/` or the schedules
      file, `git pull && uv sync --frozen && systemctl restart fiesta-ops-worker`
      (or extend the deploy workflow to MARFIK3 later).
- [ ] **Check out and sync osu-mgr-pipeline on MARFIK3** at the schedule's
      `cwd` (confirm `/srv/osu-mgr-pipeline` or change `cwd` in the schedules
      file): `git clone https://github.com/osu-mgr/osu-mgr-pipeline
      /srv/osu-mgr-pipeline && cd /srv/osu-mgr-pipeline && uv sync` (the command
      runs `.venv/bin/python`), then its `.env` with the OpenSearch and AWS/S3
      credentials it uses today (the pipeline loads it itself; FIESTA's
      variables are not passed to it). Check by hand once, as the service user:
      `.venv/bin/python osu_mgr_pipeline.py --incremental --since 72h --dry-run`.
      It must never run concurrently with itself, so stop any other cron or
      manual schedule for it once this one is live.
- [ ] **Env file `/etc/fiesta/ops-worker.env`** (owner root, group `fiesta`,
      mode 0640):

      ```
      FIESTA_DATABASE_URL=<same value as the FIESTA API's: the database whose procrastinate tables the jobs live in>
      FIESTA_SLACK_BOT_TOKEN=xoxb-…
      ```
- [ ] **Network access from MARFIK3**: FIESTA's Postgres (host and port of
      `FIESTA_DATABASE_URL`, plus any `pg_hba`/security-group rule for MARFIK3's
      address), the OpenSearch cluster and S3 (`s3.amazonaws.com` and the
      bucket's regional endpoint) for the pipeline, and `slack.com:443`.
- [ ] **systemd unit for the ops worker on MARFIK3**, modelled on the
      fiesta-ct worker unit above; `/etc/systemd/system/fiesta-ops-worker.service`:

      ```ini
      [Unit]
      Description=FIESTA ops worker (scheduled operations, ops queue)
      Wants=network-online.target
      After=network-online.target

      [Service]
      Type=simple
      User=fiesta
      Group=fiesta
      WorkingDirectory=/srv/fiesta-ops/FIESTA/backend
      EnvironmentFile=/etc/fiesta/ops-worker.env
      Environment=FIESTA_CONFIG_FILE=../config/fiesta.yaml
      ExecStart=/srv/fiesta-ops/FIESTA/backend/.venv/bin/fiesta ops-worker
      Restart=always
      RestartSec=10
      # a stop gives running jobs 30 s (--graceful-timeout), then stops their
      # process groups and reports them interrupted; the cgroup kill is the backstop
      KillMode=control-group
      TimeoutStopSec=120

      [Install]
      WantedBy=multi-user.target
      ```

      `systemctl daemon-reload && systemctl enable --now fiesta-ops-worker`;
      `journalctl -u fiesta-ops-worker -f` shows each job's output. Then
      `fiesta ops-run osu-mgr-incremental` (same directory and env) to see a
      ✅ in the channel, and `fiesta ops-status` for the history. Run only one
      ops worker.
- [ ] **Missed-run timer on fiesta-ct** (a dead MARFIK3 cannot report itself).
      Needs `FIESTA_SLACK_BOT_TOKEN` in the env file it uses, `slack.com:443`
      from fiesta-ct, and the same `FIESTA_DATABASE_URL` as the ops worker (if
      fiesta-ct's API uses a different database, point this unit at the ops
      worker's). `/etc/systemd/system/fiesta-ops-watchdog.service`:

      ```ini
      [Unit]
      Description=FIESTA missed-run check for scheduled operations

      [Service]
      Type=oneshot
      User=<the API unit's user>
      WorkingDirectory=/srv/fiesta/current/backend
      EnvironmentFile=<the API unit's env file>
      Environment=FIESTA_CONFIG_FILE=../config/fiesta.yaml
      ExecStart=/srv/fiesta/current/backend/.venv/bin/fiesta ops-watchdog --post --every 3600
      # exit 1 means "something is overdue" and was posted to Slack
      SuccessExitStatus=1
      ```

      and `fiesta-ops-watchdog.timer`:

      ```ini
      [Unit]
      Description=Hourly FIESTA missed-run check

      [Timer]
      OnCalendar=hourly
      AccuracySec=1min

      [Install]
      WantedBy=timers.target
      ```

      `systemctl enable --now fiesta-ops-watchdog.timer`.
- [ ] **Optional, in osu-mgr-pipeline:** have `--incremental` write a JSON
      object of its counts (cruises reprocessed, docs indexed, warnings) to the
      path in `FIESTA_OPS_SUMMARY_JSON`, or print it as its last stdout line, so
      the ✅ message carries them. Without it the message has only the duration.

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
