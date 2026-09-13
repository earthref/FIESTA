# FIESTA API contract

There is **one** FastAPI process — `fiesta.apps.api:create_app` — serving every
node in the deployment under `/v1/{repository}/...` (this is `api.earthref.org`
and what the SPA talks to directly). The deployment is described by
`config/fiesta.yaml` (`deployment: api`, `api: {title, nodes: [magic.yaml, ...]}`);
`FIESTA_NODE` (comma-separated keys/slugs, empty = all) narrows which of those
nodes a given process serves. A single node YAML still loads on its own as a
one-node deployment (used by the tests).

`{repository}` is a node **key or slug in any case** (`MagIC`, `magic`) — it is
resolved per request by `NodeDep`; an unknown repository is a 404. Every
node-scoped router is mounted once and serves all enabled nodes.

Interactive docs live at `/v1/docs`; the schema at `/v1/openapi.json`.

All endpoints return JSON unless noted. Errors follow
`{"detail": string | [{loc, msg, type}]}` (FastAPI convention).

## Authentication

Two schemes are accepted; the private routes take either.

- **Bearer token** — `POST /v1/auth/login` (OAuth2 password form) returns a
  HS256 JWT; send it as `Authorization: Bearer <jwt>`. This is what the SPA uses.
- **HTTP Basic** — EarthRef account email or handle + password. Kept for legacy
  `api.earthref.org` clients; the legacy routes accept Basic only, while the
  shared private-workspace routes accept either scheme.

## Node-less routes

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/v1/health-check` | — | `{status, database, search, storage, repositories}` |
| GET | `/v1/authenticate` | Basic | `UserOut` (legacy Basic check) |
| POST | `/v1/auth/register` | — | `UserOut` (201); body `{email, password, name}`, password ≥ 8 chars |
| POST | `/v1/auth/login` | — | `{access_token, token_type: "bearer"}`; OAuth2 password form (`username`, `password`) |
| GET | `/v1/auth/me` | Bearer/Basic | `UserOut` |
| GET | `/v1/auth/settings` | Bearer/Basic | the account's settings JSON object |
| PUT | `/v1/auth/settings` | Bearer/Basic | saved settings (body is a JSON object, capped at 16 KiB) |
| POST | `/v1/auth/local-login` | — | `{access_token, ...}` or `null` — signs in the seeded `developer@example.test` only against local dev infrastructure |

`UserOut = {id, email, name, orcid: string|null, is_admin: bool}`

`GET /v1/health-check` reports each dependency and the nodes this process serves:

```json
{
  "status": "ok",           // "degraded" if any dependency is down
  "database": true,
  "search": true,
  "storage": true,
  "repositories": ["CDR", "ERDA", "KArAr", "KdD", "MagIC", "OSU-MGR"]
}
```

## Per-node routes (`/v1/{repository}/...`)

### Config & reference (public, cacheable)

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/{repository}/config` | Public node config (below) |
| GET | `/v1/{repository}/config/assets/{path}` | static file from `config/<slug>/assets/` (news images, …) |
| GET | `/v1/{repository}/config/data-models/{version}` | Full data model JSON for a version (404 if unknown) |
| GET | `/v1/{repository}/config/vocabularies/controlled` | `{<name>: {label, database_column, items: [{item, label?}]}}` |
| GET | `/v1/{repository}/config/vocabularies/suggested` | same shape |
| GET | `/v1/{repository}/config/method-codes` | `{<group>: {label, codes: [{code, definition, ...}]}}` (404 if the node has none) |

`GET /v1/{repository}/config` response:

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
  "features": {"pages": ["about", "help"], "plugins": ["poles"]},
  "has_method_codes": true,
  "doi_prefix": "10.7288",
  "plugins": {"poles": { /* frontend_config per active plugin */ }},
  "portal_urls": {"cdr": "http://localhost:8082", ...}
}
```

`search_levels` is extended with any plugin-contributed levels; `plugins` (a map
of active plugin name → its `frontend_config`) and `portal_urls` (local-dev
sibling-node links) are added by the config route on top of the node's own
`public_config()`.

### Search & retrieval

| Method | Path | Query params | Returns |
|---|---|---|---|
| GET | `/v1/{repository}/search/{table}` | `query` (free text / `term:"value"` tokens), `size` (default 10, 1–1000), `from`, `facets` (bool), `range` (repeatable `field:gte:lte`), `bbox` (`minLon,minLat,maxLon,maxLat`), `sort` (see below) | `SearchPage` |
| GET | `/v1/{repository}/contributions/{id}` | `private_key?` | Contribution summary doc |
| GET | `/v1/{repository}/contributions/{id}/download` | `private_key?` | canonical text file (`text/plain` attachment) |

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

### Private workspace (`/v1/{repository}/private/contributions`, Bearer or Basic)

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

### Workspaces (`/v1/{repository}/workspaces`, Bearer or Basic)

Shared workspaces: owners control membership, editors save, viewers read.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v1/{repository}/workspaces` | | workspaces the caller owns, is a member of, or (admin) all — with the caller's `role` |
| POST | `/v1/{repository}/workspaces` | `{name}` | `{id, name}` (201) |
| PUT | `/v1/{repository}/workspaces/{workspace_id}/members` | `{user_id, role: "viewer"\|"editor"}` | `{role}` (owner only) |
| DELETE | `/v1/{repository}/workspaces/{workspace_id}/members/{user_id}` | | 204 (owner only) |
| PUT | `/v1/{repository}/workspaces/{workspace_id}/contributions/{contribution_id}` | | `{workspace_id}` (assign an owned contribution) |

### Legacy compatibility (`/v1/{repository}`, HTTP Basic on private routes)

Kept for legacy `api.earthref.org` clients: the singular `/private/contribution`
shape, `/data` and `/download`. New clients and the SPA use the search, private
and workspace routes above.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/{repository}/data/{id}` | — (`key?`) | contribution file as `text/plain` |
| GET | `/v1/{repository}/download/{id}` | — (`key?`) | zip archive of the contribution's revision files |
| POST | `/v1/{repository}/validate` | — | upload a file, synchronous validation report |
| GET | `/v1/{repository}/private/search/{table}` | Basic | search the caller's own private data |
| POST | `/v1/{repository}/private/contribution` | Basic | create a private contribution (optional `file`) → `{id, private_key}` (201) |
| PUT | `/v1/{repository}/private/contribution/{id}` | Basic | replace the file → `{id, status}` |
| DELETE | `/v1/{repository}/private/contribution/{id}` | Basic | delete a private (unactivated) contribution → 204 |
| GET | `/v1/{repository}/private/contribution-list` | Basic | the caller's contributions |

### Plugins (`/v1/{repository}/plugins/{name}/...`)

Each plugin router mounts once per plugin. A request to a node that does not
activate that plugin (`features.plugins` in its YAML) is a 404. Plugin routes
read contribution data through `fiesta.plugins.util.load_visible_parsed`, which
enforces the same visibility rules as the core API.

| Method | Path | Plugin (node) |
|---|---|---|
| GET | `/v1/{repository}/plugins/poles/base-texture` | `poles` (MagIC) — earth-relief JPEG |
| GET | `/v1/{repository}/plugins/poles/plate-boundaries` | `poles` (MagIC) — GeoJSON |
| GET | `/v1/{repository}/plugins/depth-plot/contributions/{id}/measurements` | `depth-plot` (CDR) |
| GET | `/v1/{repository}/plugins/plateau-calculations/contributions/{id}/experiments/{name}/plateau` | `plateau-calculations` (KArAr) |

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
