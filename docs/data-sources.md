# Contribution modes and data sources

Every node runs in one of two modes, per deployment:

| Mode | Contributions are made | FIESTA |
|---|---|---|
| `public` | in FIESTA: upload, validate, publish, new versions | the system of record |
| `source` | at the node's data source (until the cutover, its Meteor app) | a mirror: a sync script writes what the source holds; users read but do not upload or change contributions |

The mode is `FIESTA_CONTRIBUTIONS_MODE` in the API's environment: one mode for
every node plus `<slug>=<mode>` exceptions, e.g. `source`, `source,karar=public`
(KArAr cut over, the rest still mirrored) or `public,kdd=source`. A local
compose stack defaults to `public` (`docker-compose.yml`); a deployment sets
`source` until it cuts over from Meteor (OPERATOR_TODO). The node YAML is the
same in both: the mode is about where a deployment's contributions come from,
not what the node is.

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
| `GET /v2/{node}/source` | `{node, mode, source_id, checkpoints: {"<id>": "<fingerprint>"}}`: the fingerprint of each source record last applied |
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
| `sources/kdd.py` | Meteor KdD: index `kdd`, bucket `kdd-activated-contributions` | first; schedule `kdd-source` (disabled until set up) |

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
`errors`) and exits 1 when any record failed. Records whose legacy owner has no
account are quarantined, not errors: they wait for an owner mapping.

## Schedules

Scripts run on the ops scheduler (`config/ops/schedules.yaml`,
[ops-scheduler.md](ops-scheduler.md)) like any other job: a `command` entry
with its cron, an `env_file` holding the variables above, and
`FIESTA_NODE_CONFIG_SOURCE=files` so the node YAML comes from the checkout.
The ops runner strips the worker's own `FIESTA_*` variables, so the script sees
only what its env file and `env` give it. The run summary's scalar fields
appear in the Slack message.
