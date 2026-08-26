# FIESTA API contract

Two FastAPI apps are built from the same codebase (`backend/`), selected by the
deployment YAML (`config/*.yaml`):

- **Node backend** (`deployment: node`) — serves one node (MagIC, CDR, KArAr)
  under `/api`. Consumed by the FIESTA frontend SPA.
- **Public API** (`deployment: public-api`) — serves `/v1` for all nodes,
  compatible with the legacy `api.earthref.org` OpenAPI surface.

All endpoints return JSON unless noted. Errors follow
`{"detail": string | [{loc, msg, type}]}` (FastAPI convention).

## Node backend (`/api`)

### Config & reference (public, cacheable)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{status: "ok", database: bool, search: bool, storage: bool}` |
| GET | `/api/config` | Public node config (below) |
| GET | `/api/config/data-models/{version}` | Full data model JSON for a version |
| GET | `/api/config/vocabularies/controlled` | `{<name>: {label, database_column, items: [{item, label?}]}}` |
| GET | `/api/config/vocabularies/suggested` | same shape |
| GET | `/api/config/method-codes` | `{<group>: {label, codes: [{code, definition, ...}]}}` (404 if node has none) |

`GET /api/config` response:

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
  "features": {"pages": ["about", "help"], "plugins": []},
  "has_method_codes": true
}
```

### Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/auth/register` | `{email, password, name}` | `UserOut` |
| POST | `/api/auth/login` | OAuth2 password form (`username`, `password`) | `{access_token, token_type: "bearer"}` |
| GET | `/api/auth/me` | (Bearer token) | `UserOut` |

`UserOut = {id, email, name, orcid: string|null, is_admin: bool}`

Authenticated endpoints take `Authorization: Bearer <jwt>`.

### Public search & data

| Method | Path | Query params | Returns |
|---|---|---|---|
| GET | `/api/search/{table}` | `query` (free text / `term:"value"` tokens), `size` (default 10), `from`, `facets` (bool) | `SearchPage` |
| GET | `/api/contributions/{id}` | `private_key?` | Contribution summary doc |
| GET | `/api/contributions/{id}/download` | `private_key?` | canonical text file (`text/plain` attachment) |

```json
SearchPage = {
  "total": 1234,
  "results": [ { ...OpenSearch _source... } ],
  "aggregations": {"<facet>": [{"key": "...", "doc_count": 1}]} | null
}
```

Search results are always restricted to `_is_latest`, and to `_is_activated`
unless a valid `private_key` token (`private_key:"<uuid>"` with `id:"<id>"`)
is in the query.

### Private workspace (Bearer auth)

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/api/private/contributions` | | `ContributionOut[]` (caller's, newest first) |
| POST | `/api/private/contributions` | | `ContributionOut` (allocates `id` + `private_key`) |
| GET | `/api/private/contributions/{id}` | | `ContributionOut` |
| PUT | `/api/private/contributions/{id}/file` | multipart `file` | `ContributionOut` (stores file, enqueues parse+validate+summarize job) |
| POST | `/api/private/contributions/{id}/validate` | | `{job_id}` (async validation) |
| GET | `/api/private/contributions/{id}/validation` | | `ValidationResult` or 404 if never validated |
| PUT | `/api/private/contributions/{id}/reference` | `{doi}` | `ContributionOut` |
| POST | `/api/private/contributions/{id}/activate` | | `ContributionOut` (publishes; requires passing validation) |
| POST | `/api/private/contributions/{id}/deactivate` | | `ContributionOut` |
| DELETE | `/api/private/contributions/{id}` | | 204 (private, unactivated only) |

```json
ContributionOut = {
  "id": 20001,
  "version": 1,
  "previous_id": null,
  "contributor_id": 1,
  "contributor_name": "...",
  "private_key": "uuid",            // only present for the owner
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

## Public API (`/v1`) — legacy-compatible

HTTP Basic auth (EarthRef account email/handle + password) on private routes.
`{repository}` is a node key: `MagIC`, `CDR`, `KArAr` (case-insensitive).

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health-check` | liveness + dependency checks |
| GET | `/v1/authenticate` | Basic auth → user info |
| GET | `/v1/{repository}/data/{id}` | contribution file (`?format=txt|json`) |
| GET | `/v1/{repository}/download/{id}` | zip archive of the contribution |
| GET | `/v1/{repository}/search/{table}` | `query`, `size`, `from`, `id`, `doi` params |
| POST | `/v1/{repository}/validate` | upload a file, synchronous validation report |
| POST | `/v1/{repository}/private/contribution` | create private contribution (Basic auth) |
| PUT | `/v1/{repository}/private/contribution/{id}` | replace file |
| DELETE | `/v1/{repository}/private/contribution/{id}` | delete private contribution |
| GET | `/v1/{repository}/private/search/{table}` | search own private data |
