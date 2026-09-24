# Phase M: development, storage and migration

Postgres is authoritative for accounts, settings, permissions, revision pointers,
publication state and audit history. S3 stores immutable contribution files,
revision manifests and processing artifacts. OpenSearch is a derived search index.

## Local development

```sh
make up FIESTA_NODE=magic,cdr
make seed FIESTA_NODE=magic,cdr
```

Docker runs Postgres, OpenSearch, RustFS, Mailpit, APIs, workers and frontends.
The current per-node process layout remains until Phase A; the same management
routers are also available on the multi-node API under `/v2/{repository}`.
No MARFIK, AWS, production credentials or live account is needed. Seed commands
refuse production mode, nonlocal endpoints and database URL connection overrides.
Docker sets `FIESTA_ENVIRONMENT=development` and a shared `fiesta-local` bucket.
Host-run developers must explicitly select development mode and local endpoints.

Each node YAML selects `development.seed_manifest`, resolved relative to that YAML.
Fixtures live under `config/<node>/seeds/`. The two local logins are
`developer@example.test` and `viewer@example.test`, both with password
`local-fiesta-only`. The owner can edit; the viewer can inspect shared workspace
contributions. Each node includes a private draft with revision history, two
independent typical public examples (`typical-1`, `typical-2`), and an `all-fields`
public example with a populated value for every column of every table in the
latest data model. MagIC also has two public pole examples with different ages,
hemispheres and confidence circles. The original public version chain and invalid
draft remain available for workflow checks, along with supplemental files and an image.
All files are synthetic development examples. The all-fields fixture uses model
examples and vocabulary values to exercise field coverage; it is not a scientifically
consistent study or an upload template (it also includes download-only fields).
Repeated seeds skip existing contributions and preserve changed settings and edits.
Seed manifests and credentials are never applied during normal server startup.

`make test-phase-m` builds dependencies first, then runs all-node seeding, tests and
storage verification on a Docker network with external connectivity disabled.
`make test-phase-m-restore` then rehearses a logical Postgres backup/restore,
compares complete account rows, verifies all retained file references, and builds
separate search aliases. It drops only its temporary restored database; production
PITR/WAL recovery must still be rehearsed by the operator.

Its project is `fiesta-phase-m-test`. Tests execute inside the isolated network;
local test ports are reserved but need not be reachable from the host. `docker compose -p fiesta-phase-m-test -f compose.phase-m-test.yml down -v` resets **only that
test project**; the normal developer stack is separate. No real DOI/OAuth/enrichment
calls are needed for this suite; those integrations remain Phase C work.

## Revisions and APIs

The contribution-management API is at `/v2/{repository}/private/contributions`.
Bearer tokens and HTTP Basic both identify Postgres accounts on these shared
management routes. Login/settings routes are node-less: `/v2/auth/*`. Account
settings are a JSON object capped at 16 KiB.

All content mutations share the revision service. A save requires the expected
head revision and an idempotency key. Multipart uploads use `If-Match` (omit only
for the initial file) and `Idempotency-Key`; JSON saves use `expected_revision`
(null for the initial save) and `request_key`. A stale save or reused key with a
different payload returns 409. Successful saves include `head_revision`,
`published_revision` and `indexing_status` in their contribution response.

| Suffix beneath a contribution | Method | Purpose |
|---|---|---|
| `/content` | GET / PUT | Read canonical text or save a complete edited text revision |
| `/revisions` | GET | Read accepted edit history |
| `/revisions/{revision}/restore` | POST | Restore a prior snapshot as a new revision |
| `/revisions/{revision}/validation` | GET | Inspect retained validation runs |
| `/attachments` | GET | List current supplemental files |
| `/attachments/{name}` | GET / PUT / DELETE | Download, upload or remove a file |
| `/versions` | POST | Start a new private version from published content |
| `/validate`, `/validation` | POST / GET | Request validation or read the current revision's report |
| `/activate`, `/deactivate` | POST | Publish the validated head or withdraw visibility |

Read content and attachments at a historical revision with `revision_id`.
The SPA's private cards expose **Edit / History / Files** and **Create new version**.
Editing starts with a text editor and explicit saves; simultaneous live cell
collaboration is not part of this implementation. Published content stays immutable
when withdrawn. A new published version gets its own contribution ID and
`previous_id`; private edit revisions do not consume public version numbers.
Delete marks a contribution inaccessible and queues index removal; retained files
and revisions are not physically erased. No automatic history expiration or blob
purging runs. Permission changes are audited separately and cannot be undone by
restoring content.

Workspace endpoints under `/v2/{repository}/workspaces` create
workspaces, assign owned contributions, and grant/revoke `viewer` or `editor` roles.
Workspace owners control membership; contributions remain editable by their original
owner and administrators. Settings and workspace management currently have API
surfaces; the existing SPA shows shared contributions, while a dedicated settings
and membership administration UI remains future work.

Legacy singular `/private/contribution` endpoints remain as compatibility adapters
using the same revision service. Their old payloads lack client revision tokens;
clients needing explicit conflict detection and idempotent retries should use the
plural management endpoints. The shared plural list now returns the richer
`ContributionOut` shape and accepts both authentication modes.

## Stored objects and processing

Keys are relative to a node's prefix in the shared bucket:

```text
contributions/<id>/blobs/<sha256>/<filename>
contributions/<id>/revisions/<uuid>/manifest.json
contributions/<id>/revisions/<uuid>/artifacts/<run>/validation.json
contributions/<id>/revisions/<uuid>/artifacts/<run>/summary.json.gz
processing-inputs/<hash>.json
migration/<source>/<id>/<fingerprint>.json
```

A revision manifest identifies its complete file set, checksums, parent, actor and
creation time. Unchanged files reuse immutable blobs. A failed transaction may
leave unreferenced objects, but never commits a head before storing its files and
manifest. Retain these objects pending reconciliation; do not apply bucket-wide
expiry rules. S3 Versioning is additional recovery protection to configure before
live import; logical undo uses revision manifests, not S3 object version order.

Postgres commits the head and outbox event in one transaction. `fiesta worker`
runs the existing mail/job worker and a separate outbox polling process. It retries
failed events, skips superseded revisions, and serializes work per contribution.
Validation is retained if indexing fails; `indexing_status` and `outbox.error` expose
that failure. `fiesta drain-outbox` retries a bounded batch for operations and tests.
Scientific search still needs OpenSearch; management, editing and settings do not.
Authorization filters are applied from Postgres before search pagination and
aggregations. At present this builds an allowed-ID filter; measure its size and
query cost on the full production inventory before cutover.

Validation and summary artifacts include revision/input hashes, configuration and
vocabulary hashes, pipeline source hash, processing versions and timestamps. Exact
model/vocabulary/config inputs are also retained. Each validation run is immutable.
Search rebuild currently regenerates summaries; cache reuse is optional future
optimization. Preserve the matching application image to reproduce the pipeline.

## Existing FIESTA data and legacy migration

Apply migration 0003 with `fiesta init`. For contributions already in the new
FIESTA database before Phase M, run `fiesta backfill-revisions`, then
`fiesta drain-outbox` and `fiesta verify-storage`. This preserves the available
canonical file as an initial revision; it does not invent earlier edits.

The legacy importer consumes explicit JSON inventory snapshots. Generate the schema
from `fiesta.services.legacy.Inventory.model_json_schema()`. A minimal record is:

```json
{
  "format": 1,
  "node": "magic",
  "source_id": "legacy-magic",
  "source_bucket": "legacy-bucket",
  "records": [{
    "id": 12345,
    "owner_email": "verified-owner@example.org",
    "created_at": "2020-01-01T00:00:00Z",
    "version": 1,
    "published": true,
    "latest": true,
    "revisions": [{
      "key": "original",
      "timestamp": "2020-01-01T00:00:00Z",
      "canonical": "contribution.txt",
      "files": {
        "contribution.txt": {
          "source": "12345/magic_contribution_12345.txt",
          "sha256": "<64 lowercase hex characters>"
        }
      }
    }]
  }]
}
```

Include every available revision and attachment. Each file may override `bucket`
and supply `version_id` to pin a historical S3 object. Without a source bucket,
file sources are local paths beneath the inventory directory (the offline fixture
path). Credentials come from environment settings, never inventory JSON. Supply
`previous_id`, DOI references, activation dates and private keys when applicable.
Pre-create verified account mappings; missing owners are reported and not imported.
Do not populate accounts from guessed filenames or contributor display names.

```sh
fiesta sync-legacy /path/inventory.json          # read/verify, no writes
fiesta sync-legacy /path/inventory.json --apply  # import and checkpoint each record
fiesta drain-outbox
fiesta verify-storage
```

Repeat with refreshed snapshots to sync new contributions, new file revisions and
metadata-only changes. Use explicit `deleted: true` tombstones; missing records do
not cause deletion. Unchanged records skip; checksums, ambiguous owners, conflicting
IDs and destination edits are reported and cause a nonzero exit. Committed records
are checkpoints, so an interrupted run resumes without importing them twice.
Original source metadata is retained in S3. Legacy remains authoritative until the
node's final cutover; use isolated copies for FIESTA pilot editing.

`fiesta legacy-inventory <node> --out <dir>` generates that snapshot from a node's
legacy Meteor sources when the node YAML has a `legacy:` block (`source_id`, `index`,
`buckets`, `users_index`). It scrolls the legacy index for `type: contribution`
documents, resolves each `@handle` through the shared `er_users` index, hashes the
activated file from the first bucket that has `<id>/<slug>_contribution_<id>.txt`,
and exports private contributions (index-only) from their indexed tables into
`<dir>/files/`. It writes `inventory.json` and `owners.json`; unresolved handles are
errors and their contributions are left out. `fiesta ensure-owners <node> <dir>/owners.json
--apply` creates the missing accounts without passwords. `fiesta sync-legacy-users
<node> --apply` copies every `er_users` account (not only owners) with its `_password`:
the legacy apps hash with plain bcrypt, so the hash is stored as `password_hash` and
EarthRef logins work unchanged. Legacy owns passwords until cutover, so a differing
legacy hash overwrites the local one; re-run it to pick up password changes. Run it with the production
environment file only through `make fiesta ENV_FILE=.env.prod ARGS="..."`; the
snapshot directory (`migration/`) is gitignored because it may hold private data.
The legacy index keeps one document per contribution updated in place, so history
before the snapshot is not recoverable and `_history` records reference changes only.

The actual six-node source inventory and metadata export adapters require verified
legacy source contracts. Existing repository evidence includes activated S3 buckets
for MagIC/KArAr/KdD and a CDR pipeline index; that is not proof of a complete current
inventory. This importer does not discover undocumented ownership/version semantics
or fabricate unavailable history. The old `seed_from_live.py` entry point is retired
because it did fabricate prior versions and used the obsolete recovery contract.

## Recovery and cutover

Back up Postgres with base backups plus continuous WAL archiving, retain matching
bucket versions, and preserve configuration and application images. Recovery is:
restore Postgres into isolation, make referenced bucket objects available, run
`fiesta verify-storage`, then `fiesta rebuild --yes`, then drain pending events.
Verification includes deleted contributions' retained history. Search rebuild takes
a maintenance lock on contribution writes, builds a fresh index and switches its
alias atomically; it does not change users, settings or contribution rows. Old
alias-backed indices remain available for operator cleanup. Migrating an old
concrete index to an alias removes that old concrete index at the successful switch.

For each live node: reconcile object counts/bytes/checksums and metadata; verify
owners, private/public reads, attachments, identifiers, DOIs and version chains;
rehearse backup/restore and failure recovery; freeze legacy writes; capture and
apply the final delta; verify and drain; switch API/frontend traffic; disable legacy
sync. Preserve legacy sources through the rollback window. Once FIESTA accepts
writes, rollback must preserve/replay those revisions before changing traffic.
Production sizing, source access, recovery targets and cutover approval remain in
[OPERATOR_TODO.md](OPERATOR_TODO.md). No live migration or deployment is performed
by the development or integration-test commands.

## Verification — 2026-09-11

The isolated Docker suite passed 51 tests, including all-node seed validation,
concurrent saves, idempotency conflicts, file-history restore, search failure and
replay, workspace permissions, immutable publication, version-pinned S3 imports,
source tombstones, destination-edit protection and the real multi-node worker.
Storage verification returned no errors for all six nodes. A logical database
restore preserved account rows, verified retained revision/file references and
rebuilt all six search indices under separate aliases. Frontend lint/build and
backend lint passed. Production-sized migration and PITR remain unverified.
