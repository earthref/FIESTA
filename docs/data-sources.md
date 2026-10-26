# Contribution modes and data sources

Every node runs in one of two modes, per deployment:

| Mode | Contributions are made | FIESTA |
|---|---|---|
| `public` | in FIESTA: upload, validate, publish, new versions | the system of record |
| `source` | at the node's data source (until the cutover, its Meteor app) | a mirror: a sync script writes what the source holds; users read but do not upload or change contributions |

The mode is `api.contributions_mode` in `config/fiesta.yaml`, overridden by
`FIESTA_CONTRIBUTIONS_MODE`: one mode for every node plus `<slug>=<mode>`
exceptions, e.g. `source`, `source,karar=public` (KArAr cut over, the rest
still mirrored) or `public,kdd=source`. `config/fiesta.yaml` says `source`
until the cutover from Meteor, so every deployment mirrors; local stacks
(`docker-compose.yml`, `make backend-dev` / `worker-dev`) and the tests set
`public`. The node YAML is the same in both: the mode is about where a
deployment's contributions come from, not what the node is.

In `source` mode:

- `/v2/{node}/private/contributions` answers reads; every write (create, upload,
  activate, new version, edit, delete, attachments) is a 409 naming where to
  contribute (`node.links.website`). The `/v1` private create/update/append/delete
  routes refuse the same way, in their Koa-style error body.
- `GET /v2/{node}/config` carries `contributions_mode: "source"`; the SPA's
  upload page and private workspace show that notice instead of the upload button.
- `/v2/{node}/source` accepts the sync (below). In `public` mode it refuses
  writes, so a sync script left running after the cutover changes nothing.

## The sync API (`/v2/{node}/source`, node admin)

| Route | |
|---|---|
| `GET /v2/{node}/source` | what the admin page's Data source tab shows: `{mode, source_id, kind, script, sync, synced, schedule: {name, last_run}, runs}` |
| `GET /v2/{node}/source/checkpoints` | `{node, mode, source_id, checkpoints: {"<id>": "<fingerprint>"}}`: the fingerprint of each source record last applied |
| `POST /v2/{node}/source/runs` | a script's report of one run, `{started_at, finished_at, ok, trigger, summary}` (an audit event, `operation = source-sync`) |
| `POST /v2/{node}/source/run` | Run now: queue the node's `<slug>-source` schedule on the ops worker |
| `PUT /v2/{node}/source/records/{id}` | multipart: `record` (a `SourceRecord`, JSON), optional `owner` (account fields; a missing account is created without a password), one part per file named `<revision key>/<file name>`. Returns `{id, status: applied\|unchanged, fingerprint, bytes}`; 409 with the reason when it cannot apply |

A record is the `fiesta sync-legacy` inventory record (`fiesta.services.legacy.
SourceRecord`): the contribution ID, owner email, version / previous ID,
published / latest / deleted flags, timestamps, private key, data model version
and its revisions with their files' sha256. Both go through one importer,
`import_record`, under the node YAML's `legacy.source_id`, so:

- IDs, version chains, DOIs and creation / activation times are the source's;
- a record whose fingerprint matches its checkpoint is a no-op, and a changed
  one becomes a new revision of the same contribution (history kept);
- a contribution changed in FIESTA since its import, or an ID FIESTA already
  uses for something else, is refused, never overwritten;
- the bulk imports already on dev (`legacy-magic`, `legacy-karar`, ...) are
  the same checkpoints: a sync continues from them instead of re-importing;
- absence from the source is never a deletion (the scripts report it as
  `missing_from_source`).

Each applied record queues the usual outbox event (parse, validate, summarize,
index), so the node's worker must be running.

## Per-node scripts (`sources/<slug>.py`)

A script reads its node's source and sends the changed records. It needs the
source's read credentials and a node admin account, never FIESTA's database.
The shared parts are in `backend/fiesta/sources/`: `client.SourceAPI` (the API
above) and `meteor` (a legacy Meteor node: its OpenSearch index and S3 archive
bucket, read with the `fiesta legacy-inventory` reader into a state directory
whose hash cache keeps unchanged S3 objects from being downloaded again).
A node-specific fix-up of the source records belongs in the node's script.

| Script | Source | Status |
|---|---|---|
| `sources/kdd.py` | Meteor KdD: index `kdd`, bucket `kdd-activated-contributions` | first; schedule `kdd-source`, off until `legacy.sync.enabled` |

Run one by hand from the repository root (`make fiesta` runs it in `backend/`
with that env file's legacy read credentials):

```bash
FIESTA_SOURCE_EMAIL=<node admin> FIESTA_SOURCE_PASSWORD=<password> \
  make fiesta ENV_FILE=/abs/path/.env.prod NODE=kdd CMD=python \
  ARGS="../sources/kdd.py --api http://localhost:18000 --dry-run"
```

| Option / variable | |
|---|---|
| `--api` / `FIESTA_SOURCE_API` | the FIESTA API base URL (it serves `/v2`) |
| `FIESTA_SOURCE_EMAIL`, `FIESTA_SOURCE_PASSWORD` | a node admin of that node |
| `FIESTA_OPENSEARCH_URL`, `FIESTA_S3_*` | read access to the legacy index, `er_users` and the archive bucket |
| `--state-dir` | snapshot, hash cache and index exports, kept between runs (default `~/.cache/fiesta/sources/<slug>`) |
| `--owner-map` | operator-approved owners for records without a usable handle (`owner_names`, `owner_handles`, `owner_overrides`, `default_owner`); never checked in |
| `--dry-run`, `--ids` | report only; limit to some IDs |

It exits 0 in `public` mode without reading the source, prints a JSON summary
as its last line (`applied`, `unchanged`, `quarantined`, `missing_from_source`,
`errors`), reports the run to `POST /source/runs` (not on `--dry-run`) and
exits 1 when any record failed. Records whose legacy owner has no
account are quarantined, not errors: they wait for an owner mapping.

## Schedule and the admin page

Each node's sync schedule is node configuration, `legacy.sync` in its YAML:

```yaml
legacy:
  source_id: legacy-kdd
  # ...
  sync:
    enabled: true       # default false
    cron: "20 * * * *"  # UTC; default hourly at :20
```

The admin node page's **Data source** tab (`/admin/nodes/<slug>?section=source`)
edits it into the draft like any other setting (publish to apply), and shows
the mode, whether the checkout has `sources/<slug>.py`, how many records are
synced, the ops scheduler's last run of the schedule (queued, running,
succeeded or failed, also for a run that crashed before reporting) and the
last 20 run reports with their counts and errors. **Run now** queues one run.

`fiesta ops-worker` ([ops-scheduler.md](ops-scheduler.md)) adds a
`<slug>-source` schedule for every node with a `legacy:` block and a script,
enabled by its `legacy.sync.enabled` (a disabled one still runs from Run now or
`fiesta ops-run <slug>-source`). It reads the published node configuration
every 30 s and, once no ops job is running, restarts on the new schedules, so a
publication takes effect without a deploy. How this host runs the scripts is the
`sources:` block of `config/ops/schedules.yaml`:

```yaml
sources:
  python: null                                   # default: the ops worker's interpreter
  cwd: null                                      # default: the checkout's backend/
  env_file: /etc/fiesta/source-{slug}.env        # the variables above
  state_dir: /var/lib/fiesta-ops/sources/{slug}
  owner_map: /etc/fiesta/source-{slug}-owners.json   # --owner-map, when the file exists
  timeout: 1h
  notify: failure                                # Slack
```

The script runs with `FIESTA_CONFIG_FILE` (this checkout's) and
`FIESTA_NODE_CONFIG_SOURCE=files`; the ops runner strips the worker's own
`FIESTA_*` variables, so it sees only what its env file gives it, plus
`FIESTA_OPS_TRIGGER` (`cron` or `manual …`, recorded in its report).
