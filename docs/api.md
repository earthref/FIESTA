# FIESTA API contract

There is **one** FastAPI process — `fiesta.apps.api:create_app` — serving every
node in the deployment under `/v2/{repository}/...` (this is `api.earthref.org`
and what the SPA talks to directly). The deployment is described by
`config/fiesta.yaml` (`deployment: api`, `api: {title, nodes: [magic.yaml, ...]}`);
`FIESTA_NODE` (comma-separated keys/slugs, empty = all) narrows which of those
nodes a given process serves. A single node YAML still loads on its own as a
one-node deployment (used by the tests).

`{repository}` is a node **key or slug in any case** (`MagIC`, `magic`) — it is
resolved per request by `NodeDep`; an unknown repository is a 404. Every
node-scoped router is mounted once and serves all enabled nodes.

Interactive docs live at `/v2/docs`; the schema at `/v2/openapi.json`.

## API versions

- **`/v2/...`** is FIESTA's own API, documented below: what the SPA uses and
  what new integrations should target. It serves every node.
- **`/v1/...`** is the legacy `api.earthref.org` contract, kept unchanged so
  existing clients (scripts, PmagPy, notebooks) keep working: the same paths,
  query parameters, Accept-header formats (`text/plain` MagIC text,
  `application/json`, `application/vnd.ms-excel`), HTTP Basic auth and
  `{"errors": [{"message": ...}]}` error shape as `old-backend/public/v1/openapi.yaml`.
  It only ever served MagIC and is tested against MagIC. See
  [Legacy v1](#legacy-v1-apiearthreforg-contract) at the end of this document.
  v1 is frozen: new behaviour goes into v2.

All endpoints return JSON unless noted. Errors follow
`{"detail": string | [{loc, msg, type}]}` (FastAPI convention).

## Authentication

Two schemes are accepted; the private routes take either.

- **Bearer token** — `POST /v2/auth/login` (OAuth2 password form) returns a
  HS256 JWT; send it as `Authorization: Bearer <jwt>`. This is what the SPA uses.
- **HTTP Basic** — EarthRef account email or handle + password. Kept for legacy
  `api.earthref.org` clients; the legacy routes accept Basic only, while the
  shared private-workspace routes accept either scheme.

## Node-less routes

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/v2/health-check` | — | `{status, database, search, storage, repositories}` |
| GET | `/v2/authenticate` | Basic | `UserOut` (legacy Basic check) |
| POST | `/v2/auth/register` | — | `UserOut` (201); body `{email, password, name}`, password ≥ 8 chars |
| POST | `/v2/auth/login` | — | `{access_token, token_type: "bearer"}`; OAuth2 password form (`username`, `password`) |
| GET | `/v2/auth/me` | Bearer/Basic | `UserOut` |
| GET | `/v2/auth/settings` | Bearer/Basic | the account's settings JSON object |
| PUT | `/v2/auth/settings` | Bearer/Basic | saved settings (body is a JSON object, capped at 16 KiB) |
| POST | `/v2/auth/local-login` | — | `{access_token, ...}` or `null` — signs in the seeded `developer@example.test` only against local dev infrastructure |

`UserOut = {id, email, name, orcid: string|null, is_admin: bool, admin_nodes: string[]}` —
`is_admin` is a **super admin** (every node, node creation, accounts); `admin_nodes`
lists the slugs of the nodes the user administers (**node admin**). A node admin
sees that node's private contributions and private keys like a super admin does.

## Admin (`/v2/admin/...`, Bearer or Basic)

Super admins may call everything; a node admin may call the node routes for
their nodes (any other slug is a 404) and list accounts. Node configuration
routes are 409 on a deployment with `FIESTA_NODE_CONFIG_SOURCE=files`.

| Method | Path | Who | Does |
|---|---|---|---|
| GET | `/v2/admin/config` | any admin | `{editing, publish_to: none\|files\|github, repository, is_super_admin, admin_nodes}` |
| GET | `/v2/admin/users?q=&role=super\|node&offset=&limit=` | any admin | `{total, users: AdminUser[]}` |
| POST | `/v2/admin/users` | super | create `{email, name, handle?, orcid?, password?, is_admin}` |
| PATCH | `/v2/admin/users/{id}` | super | any of those fields plus `admin_nodes: [slug]` (replaces the roles); the last super admin cannot be demoted |
| GET | `/v2/admin/nodes` | any admin | nodes the caller administers: `{slug, key, title, color, served, published, draft, draft_is_stale, admins}` |
| POST | `/v2/admin/nodes` | super | new node as a draft only: `{slug, key, title, template}` copies the template node's data models and vocabularies |
| GET | `/v2/admin/nodes/{slug}` | node | the above plus `revisions` (history) and the known `plugins` |
| PUT / DELETE | `/v2/admin/nodes/{slug}/admins/{user_id}` | node | grant / revoke a node admin |
| GET | `/v2/admin/nodes/{slug}/files?rev=` | node | the tree `{files: [{path, sha256}], changes: [{path, change}]}` (changes vs published) |
| GET | `/v2/admin/nodes/{slug}/file?path=&rev=` | node | `{path, revision, state, lock_version, size, encoding: utf-8\|base64, content}` |
| GET | `/v2/admin/nodes/{slug}/settings?rev=` | node | the node YAML parsed to JSON (the Pages and Search Filters tabs edit its `pages` and `search.filters` lists through the settings PATCH; page HTML is a file PUT to `<slug>/pages/<page>.html`) |
| PUT | `/v2/admin/nodes/{slug}/draft/file` | node | `{path, content, encoding?, lock_version?}` — write a file into the draft (JSON/YAML syntax checked) |
| DELETE | `/v2/admin/nodes/{slug}/draft/file?path=&lock_version=` | node | remove a file from the draft |
| PATCH | `/v2/admin/nodes/{slug}/draft/settings` | node | `{ops: [{path: [...], value}], lock_version?}` — edit the YAML keeping its comments; `value: null` deletes |
| POST | `/v2/admin/nodes/{slug}/draft` | node | open the draft, optionally `{from_revision: n}` to roll back |
| DELETE | `/v2/admin/nodes/{slug}/draft` | node | discard the draft |
| GET | `/v2/admin/nodes/{slug}/validate?rev=` | node | `{ok, errors, protected_changes, can_publish, changes}` |
| POST | `/v2/admin/nodes/{slug}/publish` | node | `{message, lock_version?}` — validate, go live, write to the repository |
| POST | `/v2/admin/nodes/{slug}/revisions/{n}/write` | node | retry the repository write of the published revision |

`rev` is `current` (draft if open, else published; the default), `draft`,
`published` or a revision number. `lock_version` is optimistic concurrency on
the draft: an edit made from content loaded from the draft sends that
draft's `lock_version` and gets a 409 if someone saved in between. Invalid
configuration is a 422 with `{"detail": {"errors": [...]}}`. A draft that
changes a protected setting (`node.key`, `node.slug`, `search.index`,
`storage`, `legacy`) can only be published by a super admin.

**Node configuration lifecycle.** Each node is a file tree, `config/<slug>.yaml`
plus `config/<slug>/**`. Postgres keeps every version of it (shared schema:
`nodes`, `node_revisions`, content-addressed `config_blobs`). Admins edit one
draft per node. Publishing it makes it the revision every API process and
worker serves (within 5 s), and writes the same bytes to the repository
(`FIESTA_CONFIG_PUBLISH`: `github` opens or updates a PR from the
`node-config/<slug>` branch, `files` writes this checkout's `config/`). `fiesta init`
imports a repository tree Postgres has never published, as a revision with
source `repo`, so changes merged in git reach the live node too. A tree that
matches any earlier publication is not imported, so a deploy never rolls back
a UI publication that is waiting for its PR to merge. A new node's first
publication creates its schema, index and storage prefix. Its SPA pages appear
after its YAML is merged and deployed, because the frontend is built per node.

`GET /v2/health-check` reports each dependency and the nodes this process serves:

```json
{
  "status": "ok",           // "degraded" if any dependency is down
  "database": true,
  "search": true,
  "storage": true,
  "repositories": ["CDR", "ERDA", "KArAr", "KdD", "MagIC", "OSU-MGR"]
}
```

## Per-node routes (`/v2/{repository}/...`)

### Config & reference (public, cacheable)

| Method | Path | Returns |
|---|---|---|
| GET | `/v2/{repository}/config` | Public node config (below) |
| GET | `/v2/{repository}/config/assets/{path}` | static file from `config/<slug>/assets/` (news images, …) |
| GET | `/v2/{repository}/config/pages/{slug}` | a content page `{slug, title, menu, icon, html}` from `config/<slug>/pages/<page>.html` (404 if the YAML does not list it); the SPA sanitizes `html` (DOMPurify) before rendering |
| GET | `/v2/{repository}/config/data-models/{version}` | Full data model JSON for a version (404 if unknown) |
| GET | `/v2/{repository}/config/vocabularies/controlled` | `{<name>: {label, database_column, items: [{item, label?}]}}` |
| GET | `/v2/{repository}/config/vocabularies/suggested` | same shape |
| GET | `/v2/{repository}/config/method-codes` | `{<group>: {label, codes: [{code, definition, ...}]}}` (404 if the node has none) |

`GET /v2/{repository}/config` response:

```json
{
  "key": "MagIC",
  "slug": "magic",
  "title": "Magnetics Information Consortium (MagIC)",
  "subtitle": "...",
  "color": "#800080",
  "links": {"website": "...", "github_issues": "..."},
  "contact_email": "magic@earthref.org",
  "data_model_versions": ["2.2", "2.3", "2.4", "2.5", "3.0"],
  "data_model_latest": "3.0",
  "search_levels": [
    {"name": "Contributions", "table": "contribution", "count_field": null},
    {"name": "Locations", "table": "locations", "count_field": "summary.locations._n_results"}
  ],
  "facets": ["method_codes", "geologic_classes"],
  "filters": [
    {"type": "facet", "field": "method_codes", "label": null, "levels": [], "views": ["Summaries", "Rows"], "unit": null, "scale": 1.0, "min": null, "max": null},
    {"type": "range", "field": "summary.poles.age", "label": "Age", "levels": ["Locations"], "views": ["Poles"], "unit": "Ma", "scale": 1000000.0, "min": null, "max": null},
    {"type": "bbox", "field": null, "label": "Geospatial", "levels": ["Locations"], "views": ["Poles"], "unit": null, "scale": 1.0, "min": null, "max": null}
  ],
  "pages": [{"slug": "about", "title": "About", "menu": "left", "icon": null}],
  "features": {"plugins": ["poles"]},
  "has_method_codes": true,
  "doi_prefix": "10.7288",
  "plugins": {"poles": { /* frontend_config per active plugin */ }},
  "deployment_nodes": ["MagIC", "KdD", "CDR", "KArAr", "ERDA", "OSU-MGR"]
}
```

`filters` are the node YAML's `search.filters`: the sidebar controls, each
restricted to the search `levels` and result `views` (Summaries, Rows, a plugin
tab) it names, empty meaning all. `facets` lists the facet filters' fields (what
`facets=true` aggregates; the pre-2026-09 YAML key `search.facets` still loads as
facet filters). `pages` are the content pages in menu order.

`search_levels` is extended with any plugin-contributed levels; `plugins` (a map
of active plugin name → its `frontend_config`) and `deployment_nodes` (the
keys of every node this API serves, which the portal bar links next to itself
off the production hosts) are added by the config route on top of the node's own `public_config()`.

### Search & retrieval

| Method | Path | Query params | Returns |
|---|---|---|---|
| GET | `/v2/{repository}/search/{table}` | `query` (free text / `term:"value"` tokens), `size` (default 10, 1–1000), `from`, `facets` (bool), `range` (repeatable `field:gte:lte`), `bbox` (`minLon,minLat,maxLon,maxLat`), `sort` (see below) | `SearchPage` |
| GET | `/v2/{repository}/contributions/{id}` | `private_key?` | Contribution summary doc |
| GET | `/v2/{repository}/contributions/{id}/download` | `private_key?` | canonical text file (`text/plain` attachment) |

```json
SearchPage = {
  "total": 1234,
  "results": [ { ...OpenSearch _source... } ],
  "aggregations": {"<facet>": [{"key": "...", "doc_count": 1}]} | null
}
```

`{table}` must be one of the node's search levels, its `extra_types`, or a
plugin-contributed table — otherwise 404. An unknown `sort`, a malformed `range`
or `bbox` is a 422. A missing search index returns an empty page rather than an
error.

Search results are always restricted to `_is_latest`, and to `_is_activated`
unless a valid `private_key` token (`private_key:"<uuid>"` with `id:"<id>"`)
is in the query.

`sort` is one of the legacy sort-dropdown options: `relevance` (score, then
newest), `recent` / `recent_asc` (contribution timestamp), `published` /
`published_asc` (`_reference.year`), `cited` (`_reference.n_citations`),
`citation_az` / `citation_za` (`_reference.citation`), `id_desc` / `id_asc`.
When omitted the API sorts by relevance if the query has free text and by
`recent` otherwise.

### Private workspace (`/v2/{repository}/private/contributions`, Bearer or Basic)

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `` | | `ContributionOut[]` (contributions the caller can access, newest first) |
| POST | `` | | `ContributionOut` (201; allocates `id` + `private_key`) |
| GET | `/{id}` | | `ContributionOut` |
| PUT | `/{id}/file` | multipart `file`; headers `Idempotency-Key` (required), `If-Match` (revision; omit only for the first upload) | `ContributionOut` (stores file, enqueues processing) |
| POST | `/{id}/validate` | | `{job_id}` (async validation; a Postgres outbox event id) |
| GET | `/{id}/validation` | | `ValidationResult` (404 if never validated) |
| PUT | `/{id}/reference` | `{doi, expected_revision, request_key}` | `ContributionOut` |
| POST | `/{id}/activate` | | `ContributionOut` (publishes; requires `status=ready` and passing validation) |
| POST | `/{id}/deactivate` | | `ContributionOut` |
| DELETE | `/{id}` | | 204 (private, unactivated only) |
| GET | `/{id}/content` | `revision_id?` | `{revision_id, text}` (canonical file text) |
| PUT | `/{id}/content` | `{text, expected_revision, request_key}` | `ContributionOut` (JSON edit) |
| GET | `/{id}/revisions` | | revision history `[{id, parent_id, actor_id, operation, created_at, files}]` |
| POST | `/{id}/revisions/{revision_id}/restore` | `{expected_revision, request_key}` | `ContributionOut` |
| GET | `/{id}/revisions/{revision_id}/validation` | | validation reports recorded against that revision |
| GET | `/{id}/attachments` | | `[{name, size, sha256}]` (non-canonical files) |
| GET | `/{id}/attachments/{name}` | `revision_id?` | file bytes (`application/octet-stream`) |
| PUT | `/{id}/attachments/{name}` | multipart `file`; `Idempotency-Key` + `If-Match` headers | `ContributionOut` |
| DELETE | `/{id}/attachments/{name}` | `{expected_revision, request_key}` | `ContributionOut` |
| POST | `/{id}/versions` | | `ContributionOut` (201; successor draft of a published contribution) |

```json
ContributionOut = {
  "id": 20001,
  "version": 1,
  "previous_id": null,
  "contributor_id": 1,
  "contributor_name": "...",
  "private_key": "uuid",            // only present for the owner or an admin
  "is_activated": false,
  "is_latest": true,
  "data_model_version": "3.0",
  "reference_doi": null,
  "filename": "magic_contribution_20001.txt" | null,
  "status": "created|uploaded|parsing|validating|summarizing|ready|failed",
  "created_at": "...", "updated_at": "...", "activated_at": null
}

ValidationResult = {
  "is_valid": bool,
  "validated_at": "...",
  "errors": [{"table": "sites", "row": 3, "column": "lat", "message": "..."}],
  "warnings": [ same shape ]
}
```

See [Phase M revision management](#phase-m-revision-management) below for the
concurrency and idempotency semantics of the mutating routes.

### Workspaces (`/v2/{repository}/workspaces`, Bearer or Basic)

Shared workspaces: owners control membership, editors save, viewers read.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v2/{repository}/workspaces` | | workspaces the caller owns, is a member of, or (admin) all — with the caller's `role` |
| POST | `/v2/{repository}/workspaces` | `{name}` | `{id, name}` (201) |
| PUT | `/v2/{repository}/workspaces/{workspace_id}/members` | `{user_id, role: "viewer"\|"editor"}` | `{role}` (owner only) |
| DELETE | `/v2/{repository}/workspaces/{workspace_id}/members/{user_id}` | | 204 (owner only) |
| PUT | `/v2/{repository}/workspaces/{workspace_id}/contributions/{contribution_id}` | | `{workspace_id}` (assign an owned contribution) |

### Plugins (`/v2/{repository}/plugins/{name}/...`)

Each plugin router mounts once per plugin. A request to a node that does not
activate that plugin (`features.plugins` in its YAML) is a 404. Plugin routes
read contribution data through `fiesta.plugins.util.load_visible_parsed`, which
enforces the same visibility rules as the core API.

| Method | Path | Plugin (node) |
|---|---|---|
| GET | `/v2/{repository}/plugins/poles/base-texture` | `poles` (MagIC) — earth-relief JPEG |
| GET | `/v2/{repository}/plugins/poles/plate-boundaries` | `poles` (MagIC) — GeoJSON |
| GET | `/v2/{repository}/plugins/depth-plot/contributions/{id}/measurements` | `depth-plot` (CDR) |
| GET | `/v2/{repository}/plugins/plateau-calculations/contributions/{id}/experiments/{name}/plateau` | `plateau-calculations` (KArAr) |

## Search document shape

Search documents keep the legacy shape `{type, summary: {contribution, <level>,
_all}, rows}`. `summary._all` unions row values (capped 500/column) for
free-text search; the workflow flags `_is_activated` / `_is_latest` /
`_private_key` live in `summary.contribution`. Public reads are always
`_is_latest` and `_is_activated` unless a matching private key is supplied.

## Phase M revision management

All content mutations go through the revision service with optimistic
concurrency and an idempotency key. File uploads (`PUT .../file`,
`PUT .../attachments/{name}`) require `Idempotency-Key` and the current
`If-Match` revision (omit `If-Match` only for the first upload). JSON
edits/references/restores/removals use `request_key` and `expected_revision`
(null for the first save). A stale save or a reused key with a different payload
is rejected. Published-version content is immutable; `POST .../versions` creates
a successor draft. `JobOut.job_id` for validation identifies a Postgres outbox
event. Processing and indexing are separate: `status=ready` does not imply
search is current. Publishing validates the exact current revision. See
[Phase M API contract and examples](phase-m.md#revisions-and-apis) for details.
</content>
</invoke>

## Legacy v1 (api.earthref.org contract)

`/v1/...` is the API that `old-backend` served at api.earthref.org, ported onto
FIESTA's Postgres-owned contributions, revision service and search projection
(`backend/fiesta/apps/routers/v1.py`). Its own OpenAPI document — the one the
legacy service published — is served unchanged at `/v1/openapi.yaml` (ReDoc at
`/v1`); nothing under `/v1` appears in `/v2/openapi.json`. It only ever served
MagIC and is tested against MagIC, though `{repository}` resolves any enabled
node key or slug. The surface is frozen: new behaviour goes into `/v2`.

Conventions, all as the legacy service had them:

- **Errors** are `{"errors": [{"message": string}]}`. An undefined path *or
  method* is a 404 with `Path '...' is not defined for this API. See
  https://api.earthref.org for more information.`; a query-parameter
  violation (`id=1a`, `n_max_rows=0`) is a 400 whose entries also carry `path`.
- **No matches** is an empty 204 (search, data, download, private routes).
- **Auth** is HTTP Basic with an EarthRef handle (case-insensitive) or email
  plus password on `/authenticate` and every `/private` route; a missing or
  wrong credential is a 401 `Username or password is not recognized.` and is
  slowed down by half a second.
- **Formats**: contribution data is MagIC text unless the `Accept` header
  names only other types — `application/json` (and nothing text-like) returns
  `{table: [rows]}`. `text/plain`, `text/*`, `*/*`, no header and
  `application/vnd.ms-excel` (the legacy "xls" export was the text file) all
  return text.
- **Tables**: `search/contributions` is the `contribution` level;
  `search/experiments` (the legacy measurement level) is FIESTA's
  `measurements` rows. Contribution results are `summary.contribution` without
  the `_`-prefixed workflow fields; every other table is the flattened `rows`.
  Queries are OpenSearch `query_string` expressions (public search joins them
  with `AND`).

| Method | Path | Auth | Parameters | Response |
|---|---|---|---|---|
| GET | `/v1/health-check` | — | | `{message: "Healthy!"}`, or 500 when search is unreachable |
| GET | `/v1/authenticate` | Basic | | `{id, handle, name: {given, family}, email, orcid, has_password}` |
| GET | `/v1/{repository}/download` | — | `n_max_contributions` (1–100, default 10), `only_latest`, `query`*, `id`*, `doi`*, `contributor_name`*, `reference_title`* — at least one of the starred | zip of `<id>/magic_contribution_<id>.txt` (`.json` when JSON is negotiated), newest first; 400 without a criterion |
| GET | `/v1/{repository}/data` | — | `id` (required), `key` | the contribution text or JSON; a private contribution only with its `key`; 502 without an `id` |
| GET | `/v1/{repository}/search/{table}` | — | `n_max_rows` (1–10000, default 10), `from` (default 0), `query`*, `included_columns`*, `missing_columns`* | `{total, table, size, from, queries, results}` |
| POST | `/v1/{repository}/validate` | — | multipart `file` (repeatable) or a raw text body | `{validation: {errors, warnings}}` of `{table, column, message, rows}` |
| GET | `/v1/{repository}/private/download` | Basic | `id`*, `doi`*, `query`*, `n_max_contributions` | zip of the caller's unpublished contributions, `.txt` and `.json` per contribution |
| GET | `/v1/{repository}/private/data` | Basic | `id` | text or JSON of an unpublished contribution the caller can read |
| PUT | `/v1/{repository}/private/validate` | Basic | `id` | `{validation}` for an unpublished contribution |
| GET | `/v1/{repository}/private/search/{table}` | Basic | `n_max_rows`, `from`, `query`* | the search page (plus `exists_fields`, `not_exists_fields`) over the caller's unpublished contributions |
| POST | `/v1/{repository}/private` | Basic | | `{id}` (201) — an empty draft |
| PUT | `/v1/{repository}/private` | Basic | `id`, multipart `file`* | `{id}` (202): the uploaded tables replace the draft's tables of the same name |
| PATCH | `/v1/{repository}/private` | Basic | `id`, multipart `file`* | `{id, rows_added}` (202): the uploaded rows are appended |
| DELETE | `/v1/{repository}/private` | Basic | `id` | `{rowsDeleted: 1}`, or `0` when nothing matched |

\* repeatable

Uploads (PUT/PATCH) go through the revision service like every other write:
the merged tables are exported as the draft's canonical file, a revision is
recorded and the process job validates and indexes it (the legacy service
parsed and summarized inline). A PUT or PATCH on a *published* contribution
starts its next version (`version + 1`, `previous_id` pointing back) and
returns the new draft's id — the legacy "new private contribution" — carrying
the original's attachments; the `contribution` table row of the existing
content is kept, as before.

Deliberate differences from the legacy code, each toward the published spec or
FIESTA's invariants:

- `/data` returns a private contribution only with its private key (the legacy
  query skipped the activation check).
- `id` on `/download` matches every version in a contribution's history (the
  legacy `_history.id` match) through Postgres lineage, and `only_latest` is a
  real boolean rather than "present".
- Public search shows every published version, superseded ones included (the
  legacy behaviour); `/v2` search shows only the latest.
- An unknown `id` on PUT/PATCH is a 204 (the spec's "no matches") rather than
  an empty 202; a file that is not MagIC text is a 500 naming the file.
- DELETE of a published contribution is a 409 (retained history is never
  erased) rather than a silent delete; `rowsDeleted` is 0 when nothing matched.
- `/private/download` archives `.txt` and `.json`; the legacy `.xls` entry was
  the text file again.
- Creating a draft no longer requires an account handle.
- `contributor_name` matches the contributor's display name and
  `reference_title` matches `summary.contribution._reference.title`, which
  FIESTA does not populate until reference enrichment (ROADMAP C6) lands.
