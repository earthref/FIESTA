# FIESTA API contract

There is **one** FastAPI process — `fiesta.apps.api:create_app` — serving every
node in the deployment under `/v2/{repository}/...` (this is `api.earthref.org`
and what the SPA talks to directly). The deployment is described by
`configurations/fiesta.yaml` (`deployment: api`, `api: {title, nodes: [magic.yaml, ...]}`);
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
| PATCH | `/v2/auth/me` | Bearer/Basic | `UserOut`; body any of `{name, email, handle, orcid}` (the user's own account; `""`/`null` clears a handle or ORCID; handle `[A-Za-z0-9_.-]{2,64}`, ORCID `0000-0000-0000-000X`); 409 on a value another account has, and on an email change while any served node is in data-source mode (legacy sync matches owners by email) |
| POST | `/v2/auth/password` | Bearer/Basic | 204; body `{current_password, new_password}` (≥ 8 chars); 403 when the account has a password and `current_password` does not match |
| POST | `/v2/auth/local-login` | — | `{access_token, ...}` or `null` — signs in `developer@example.test` only against local dev infrastructure, first creating the seed manifest's accounts on an unseeded stack (`null` elsewhere) |
| GET | `/v2/basemap/{world\|arctic}` | — | JPEG: Esri Ocean as a 1024×512 plate carrée world image (blank past ±85.05°) and its Arctic band; fetched from Esri once a day and cached in the API process, for the result thumbnails |
| GET | `/v2/basemap/moon` | — | JPEG: the Moon (LROC WAC) as a 1024×512 plate carrée image, pole to pole, from USGS Astrogeology's WMS; cached the same way, for the thumbnails of records on the Moon |
| GET | `/v2/portal/users` | — | `{nodes, total, users: [{id, name, handle, orcid, counts, total}]}`: every user with a public contribution (activated, latest, not deleted) and how many they have per node; no email. Query `q` (every word in name/handle/ORCID), `sort` (`total`, a node slug, `name`, `handle`, `orcid`), `order` (`asc`\|`desc`), `offset`, `limit` (≤ 1000, default 100). The portal's Users page |
| GET | `/v2/portal/references` | — | `{nodes, total, references: [{doi, citation, title, journal, year, long_citation, counts, total}]}`: every reference DOI (normalized, upper case) a public contribution cites and how many cite it per node; the metadata from the `doi_references` cache, `null` until fetched. Same query parameters (`sort` also `citation`, `title`, `year`, `doi`; blanks sort last). The portal's References page |
| GET | `/v2/basemap/undersea-features` | — | GeoJSON `FeatureCollection` of the IHO-IOC GEBCO Gazetteer of Undersea Feature Names (NOAA NCEI's feature service), each `{name, kind: point\|line\|area}` with areas reduced to their middle point; fetched once a day and cached, for the Map tab's labels |

In both `/v2/portal` lists `counts` maps a node slug to its number of public contributions (a node
with none is absent) and `nodes` (`[{slug, key, color}]`) lists the nodes with any, among those whose
web app the deployment serves; the per-node counts are cached in the API process for 5 minutes.

`UserOut = {id, email, name, handle: string|null, orcid: string|null, has_password: bool, is_admin: bool, admin_nodes: string[]}` —
`has_password` is false for an account imported without one (it sets a password without a current one);
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
| GET | `/v2/admin/nodes/{slug}` | node | the above plus `revisions` (history) and `plugins`: every plugin in the code as `{name, description, schema}` (the JSON schema of its options, defaults included; the Plugins tab switches a plugin on in `features.plugins` and edits its options under `plugins.<name>` through the settings PATCH) |
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
`storage`, `legacy`, `publish`) can only be published by a super admin.

**Node configuration lifecycle.** Each node is a file tree, `configurations/<slug>.yaml`
plus `configurations/<slug>/**`. Postgres keeps every version of it (shared schema:
`nodes`, `node_revisions`, content-addressed `config_blobs`). Admins edit one
draft per node. Publishing it makes it the revision every API process and
worker serves (within 5 s), and writes the same bytes to the repository
(`FIESTA_CONFIG_PUBLISH`: `github` opens or updates a PR from the
`node-config/<slug>` branch, `files` writes this checkout's `configurations/`). `fiesta init`
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
| GET | `/v2/{repository}/config/assets/{path}` | static file from `configurations/<slug>/assets/` (news images, …) |
| GET | `/v2/{repository}/config/pages/{slug}` | a content page `{slug, title, menu, icon, html}` from `configurations/<slug>/pages/<page>.html` (404 if the YAML does not list it); the SPA sanitizes `html` (DOMPurify) before rendering |
| GET | `/v2/{repository}/config/data-models/{version}` | Full data model JSON for a version (404 if unknown) |
| GET | `/v2/{repository}/config/vocabularies/controlled` | `{<name>: {label, database_column, items: [{item, label?}]}}` |
| GET | `/v2/{repository}/config/vocabularies/suggested` | same shape |

`GET /v2/{repository}/config` response:

```json
{
  "key": "MagIC",
  "slug": "magic",
  "title": "Magnetics Information Consortium (MagIC)",
  "subtitle": "...",
  "color": "#800080",
  "logo": "logo.svg",
  "links": {"website": "...", "github_issues": "..."},
  "data_model_versions": ["2.2", "2.3", "2.4", "2.5", "3.0"],
  "data_model_latest": "3.0",
  "search_levels": [
    {"name": "Contributions", "table": "contribution", "count_field": null, "geo": true},
    {"name": "Locations", "table": "locations", "count_field": "summary.locations._n_results", "geo": true}
  ],
  "facets": ["method_codes", "geologic_classes"],
  "filters": [
    {"type": "facet", "field": "method_codes", "label": null, "levels": [], "views": ["Summaries", "Rows"], "unit": null, "scale": 1.0, "min": null, "max": null},
    {"type": "range", "field": "summary.poles.age", "label": "Age", "levels": ["Locations"], "views": ["Poles"], "unit": "Ma", "scale": 1000000.0, "min": null, "max": null},
    {"type": "bbox", "field": null, "label": "Geospatial", "levels": ["Locations"], "views": ["Poles"], "unit": null, "scale": 1.0, "min": null, "max": null}
  ],
  "map_colors": [
    {"label": "Age", "field": "age", "unit": "Ma", "scale": 1000000.0, "log": true, "tables": ["locations", "sites"]}
  ],
  "bodies": ["moon"],
  "pages": [{"slug": "about", "title": "About", "menu": "left", "icon": null}],
  "features": {"plugins": ["poles"]},
  "publish": {"api": true, "web": true},
  "web_published": true,
  "doi_prefix": "10.7288",
  "geography": {"geologic": ["plate_blocks", "terranes"], "geographic": ["country", "location"]},
  "search_placeholder": "e.g. metamorphic \"field intensity\" -precambrian",
  "plugins": {"poles": { /* frontend_config per active plugin */ }, "method-codes": {"has_codes": true}},
  "deployment_nodes": ["MagIC", "KdD", "CDR", "KArAr", "ERDA", "OSU-MGR"],
  "hidden_nodes": ["OSU-MGR"]
}
```

`filters` are the node YAML's `search.filters`: the sidebar controls, each
restricted to the search `levels` and result `views` (Summaries, Rows, a plugin
tab) it names, empty meaning all. `facets` lists the facet filters' fields (what
`facets=true` aggregates; the pre-2026-09 YAML key `search.facets` still loads as
facet filters). `map_colors` are the node YAML's `search.map_colors`, what the
Map tab's "Color by" menu offers (as `color_by` on `/search/{table}/points`) on
the levels whose table is in `tables`; `field` is a column or a `summary.*`
path, and a value / `scale` is what the legend shows. `bodies` are the planetary
bodies besides Earth the node YAML's `search.bodies` can put a record on (empty
for most nodes), for the Map tab's Earth / Moon buttons. `pages` are the content
pages in menu order.

Each active plugin's `frontend_config` is built from its options: the node
YAML's `plugins.<name>` map over the plugin's declared defaults.

A level's `geo` is true when its table has a latitude and a longitude column
(`lat`/`lat_s`/`lat_n` and `lon`/`lon_w`/`lon_e`) in the latest data model, and
for the contribution level when any level does: the SPA gives those levels a
Map tab. Each level's `columns` is its summary grid (see Search). `search_levels` is extended with any plugin-contributed levels (no `geo`); `plugins` (a map
of active plugin name → its `frontend_config`) and `deployment_nodes` (the
keys of every node this API serves, which the portal bar links next to itself
off the production hosts) and `hidden_nodes` (the keys of the nodes whose web
app is not published, which the portal bar leaves out) are added by the config
route on top of the node's own `public_config()`.

`publish` is the node YAML's `publish` block (both default `true`; a super admin
toggles them under Settings). Outside a local stack (`FIESTA_ENVIRONMENT=development`
serves every node either way), `publish.api: false` makes every
`/v2/{repository}/...` route of the node a 404, and `publish.web: false` makes
`web_published` false: the SPA shows a "not published" notice instead of the
node, and the portal bar and the FIESTA portal home leave it out. `publish.web`
needs `publish.api`.

### Search & retrieval

| Method | Path | Query params | Returns |
|---|---|---|---|
| GET | `/v2/{repository}/search/{table}` | `query` (free text / `term:"value"` tokens), `size` (default 10, 1–1000), `from`, `facets` (bool), `facet` (repeatable column: aggregate these instead of the sidebar's facets — a sidebar facet or a facet of the level's grid columns, else 422), `facet_size` (values per facet, default 100, 1–2000; a filter modal asks for the whole list), `range` (repeatable `field:gte:lte`), `bbox` (`minLon,minLat,maxLon,maxLat`), `sort` (see below), `filter` (repeatable `<column>:<text>`, see below), `has` (repeatable `[!]<table>:<column>`, see below), `contribution` + `private_key?` (see below), `mine?` / `versions?` (scope, see below), `totals` (bool, see below), `source` (repeatable `summary.<block>.<name>`, 1–50: each result holds only those fields, for a view paging through thousands of matches) | `SearchPage` |
| GET | `/v2/{repository}/search/{table}/points` | `query`, `range`, `bbox`, `filter`, `has`, `contribution`, `private_key?` (as above), `color_by?` | `MapPoints` |
| GET | `/v2/{repository}/search/{table}/values` | `field` (repeatable, 1–50, `summary.<block>.<name>`), `query`, `range`, `bbox`, `contribution`, `private_key?` | `SearchValues` |
| GET | `/v2/{repository}/search/{table}/histogram` | `field` (a numeric `summary.<block>.<name>`, else 422), `bins` (default 40, 1–200), `log` (bool), `query`, `range`, `bbox`, `filter`, `has`, `contribution`, `private_key?` | `SearchHistogram` |
| GET | `/v2/{repository}/search/{table}/numbers` | `query`, `range`, `bbox`, `filter`, `has`, `contribution`, `private_key?` | `{total, columns: {<column>: n}}` — the level's number columns (`summary._num.<column>`, data-model order) and how many matches have a value of each, zeros included (the `numeric` filter's column picker) |
| GET | `/v2/{repository}/search/{table}/filters` | `count` (repeated: `geo`, `bbox`, `numeric`, `exists`, `facet:<column>`, `range:<path>`; else 422), `query`, `range`, `bbox`, `filter`, `has`, `contribution`, `private_key?` | `{total, counts: {<key>: n}}` — of the matches, how many have a value for each sidebar filter (a position, any number column, any recorded table, the facet's column, the range's field), zeros included: the count beside each filter in the search sidebar, which is disabled at zero |
| GET | `/v2/{repository}/search/{table}/has` | `of` (one of the level's `exists_tables`, else 422), `query`, `range`, `bbox`, `filter`, `has`, `contribution`, `private_key?` | `{total, with_table, columns: {<column>: n}}` — of the matches, how many have the table `of` and how many have a value in each of its columns (data-model order, zeros included); those without a column are `with_table` − n (the `exists` filter's modal; the caller leaves `of`'s own `has` entries out) |
| GET | `/v2/{repository}/contributions/{id}` | `private_key?` | Contribution summary doc |
| GET | `/v2/{repository}/contributions/{id}/download` | `private_key?` | canonical text file (`text/plain` attachment) |
| GET | `/v2/{repository}/contributions/{id}/versions` | `private_key?` | the `previous_id` chain, oldest first: every published version plus this one — `[{id, version, data_model_version, timestamp, contributor, is_activated, is_latest}]` |
| GET | `/v2/{repository}/contributions/{id}/rows` | `private_key?` | per-table row stats — `{validated, previous: {id, version} \| null, tables: {<table>: {errors?, warnings?, changed?, removed?}}}`: distinct rows the current revision's validation flagged, and rows added/edited (`changed`) or dropped (`removed`) since the previous published version, ignoring the stamped `row_id`/`contribution_id` (the contribution modal's level-tab badges) |
| GET | `/v2/{repository}/contributions/{id}/tables/{table}` | `private_key?`, `sort?` (`<column>:asc\|desc`), `from?`, `size?` (≤1000, default 100) | one page of a data-model table of the contribution's current file, in file order or sorted over the whole table (numbers numerically, blanks last) — `{total, columns, validated, column_issues: {<column>: {severity, messages}}, rows: [{row, values, issues: {<column> \| "": {severity: error\|warning, messages}}}]}`; `row` is the 1-based position in the file's table that validation issues name, `""` an issue on the whole row (the contribution modal's level tabs; 404 for a table not in the data model, no rows for a file without it) |
| GET | `/v2/{repository}/contributions/{id}/tables/{table}/locate` | `values` (a row as a JSON object), `private_key?` | where a search doc's row sits in the file's table — `{row}`, the 1-based position of the first row whose named columns all equal `values` as text (blank matching blank), or null (the search page's Rows grid opening the modal on that row) |

```json
SearchPage = {
  "total": 1234,
  "results": [ { ...OpenSearch _source... } ],
  "aggregations": {"<facet>": [{"key": "...", "doc_count": 1, "rows_count": 4?, "mapped_count": 1?}]} | null,
  "rows_total": 5678 | null,
  "mapped_total": 1200 | null
}
```

With `totals=true`, `rows_total` is the matches' rows (the level's `count_field`
summed, a doc without it counting as one) and `mapped_total` the matches with a
position (levels whose `geo` is true): the search page's Rows and Map sub-tab
counts. Otherwise both are null. Each facet bucket likewise carries
`rows_count` (levels with a `count_field`) and, with `totals` on a `geo` level,
`mapped_count`, so the sidebar's facet counts follow the active sub-tab; a
plugin view's sub-tab takes its facets from a `facets=true` search of its own
table.

```json
MapPoints = {
  "total": 410,
  "points": [{"id": 106, "name": "S106-0", "lat": 0.07, "lon": 175.9, "count": 12?, "value": 1.5e6?, "body": "moon"?}],
  "truncated": false
}
```

`points` is every match with a `summary._all._geo_point` or `_body_point`, up
to 50,000 (`truncated` past that), for the search page's Map tab: `id` is the
contribution, `name` the row's own key column (`sites` → `site`; absent at the
contribution level), `body` the planetary body a point on another one is on
(`moon`; absent on Earth). A doc with several positions (a
contribution; an area such as a location, mapped at its sites' and samples'
positions rather than drawn as its box) gives a point per position it carries
(only those inside `bbox`, when one is given: a `bbox` is on Earth, so it
leaves out the points on other bodies). `{table}` must be a level whose
`geo` is true, otherwise 404.

Past 10,000 matches at a level of single points (not the contribution level,
not an area level, not scoped to one `contribution`), `points` are the
matches' unique locations instead: a composite aggregation of ~2.4 m geotiles
(zoom 24) by contribution, each point at its records' centroid (to 5 decimals)
with their `count` and no `name`; `total` is still the matching records and
`truncated` means more than 50,000 locations. Records on other bodies are
added one point each.

`color_by` is the `field` of one of the node's `search.map_colors` offered at
this level (`GET /config`'s `map_colors[].tables`; otherwise 400) and adds each
point's `value`: the record's value parsed as a number, in the field's base
unit by its `unit_column` (an age in years BP by its `age_unit`), or for a
location the mean of its records' values (a Painless `avg` in the
aggregation). A record without a usable value has no `value`.

```json
SearchValues = {
  "total": 3111,
  "fields": ["summary.specimens.specimen", "summary.rock_mag.mr_ms"],
  "rows": [["S1a1", 0.21], ["S1a2", null]],
  "truncated": false
}
```

`values` is the given summary fields of every match, one row per doc in
`field` order (a list value gives its first element; a missing or non-scalar
one is `null`), up to 50,000 rows (`truncated` past that), for plots of many
docs (the `rock-mag` plugin's Rock Magnetism view). A field must be a path
under `summary` at least three deep, and no part of it may start with
`_private` (422 otherwise). Visibility is the same as the search's.

```json
SearchHistogram = {
  "total": 53, "counted": 53,
  "min": 19000000.0, "max": 1779100032.0, "positive_min": 19000000.0,
  "log": false,
  "bins": [{"lo": 19000000.0, "hi": 371020006.4, "count": 10}, ...]
}
```

`histogram` is a numeric summary field's distribution over the matches (a
range filter's modal; the caller leaves the field's own range out of
`range`): `bins` equal-width bins from its min to its max, each `[lo, hi)` and
the last closed so the max is counted, as `range` aggregation buckets. With
`log` the bins are equal in log10 between `positive_min` (the smallest value
above zero) and the max, values at or below zero left out; without positive
values `log` comes back false and the bins are linear. `counted` docs have a
value in a bin; a field no match has has no bins, and a text field (row values
are strings) is a 422 — a data-model number column's histogram is on its
`summary._num.<column>`. Field rules and visibility are as for `values`.
A `range` on a multi-valued field (`summary._num`) matches a doc with any value
inside it.

Positions (`summary._all._geo_point`, one `{lat, lon}` or a list): a record's
rows' own `lat`/`lon` (a box that is a single point counts as one). A record of
an area level (a table with `lat_s`/`lat_n`/`lon_w`/`lon_e`, e.g. MagIC
locations) also carries every distinct position of the rows below it that name
it (its sites' and samples', up to 500), and is mapped at those rather than
drawn as its box. A record with none of these takes the middle of its box (the
narrower of the two its longitudes bound, so swapped corners stay put), or else
its nearest ancestor's position, found by that level's key column (a
specimen's `sample`), so a geospatial filter narrows every level. A level is
`geo` when its table has coordinate columns or such a key column. The
contribution doc carries every distinct position of its records (up to 500),
so it matches an area that holds any of them. A row on another planetary body — one whose column named by the
node YAML's `search.bodies` (MagIC and KArAr: `location_type`) has a value it
maps to a body (`Lunar` → `moon`; `Martian` is not one: MagIC's and KArAr's Martian samples are meteorites, found on Earth), and every row below it —
has its position as `summary._all._body_point` (`{lat, lon, body}`; a list on
the contribution doc) instead, so Earth's area filters and location
aggregations leave it out; `mapped_total` counts either.
Visibility is the same as the search's. The SPA sends the Map tab's area
filter as `bbox` here and to `/search/{table}`, with a `minLon` east of `maxLon`
when it crosses the antimeridian.

`contribution=<id>` scopes either search to that one contribution, as the
contribution modal's level tabs, counts and map do: its docs of any version,
public or opened by `private_key` (the same check as `GET /contributions/{id}`,
a 404 otherwise), in place of the `_is_latest` / `_is_activated` filters.

`{table}` must be one of the node's search levels, its `extra_types`, or a
plugin-contributed table — otherwise 404. An unknown `sort`, a malformed `range`
or `bbox` is a 422. A missing search index returns an empty page rather than an
error.

Search results are restricted to `_is_latest`, and to `_is_activated`
unless a valid `private_key` token (`private_key:"<uuid>"` with `id:"<id>"`)
is in the query. Two scope parameters, accepted by `/search/{table}` and its
`/points`, `/values`, `/histogram` and `/numbers` (the search page sends them
with every request, so the level tabs' counts follow), relax or narrow that:

- `versions=all` (default `latest`) drops the `_is_latest` restriction: older
  versions of contributions too, still only the published ones.
- `mine=in_prep|published` narrows the search to the signed-in user's own
  contributions (`summary.contribution._contributor_id` = the bearer token's
  user, never a client-supplied id): `in_prep` the unpublished ones (the one
  way to search unpublished docs without a private key), `published` the
  published ones. Anonymous (or an expired token): 401. Postgres decides what
  may appear (`fiesta.services.access.constrain_search`, as for every search):
  in prep, only contributions the user may access, so a stale doc naming
  another contributor still never shows another user's work.

Both are ignored with `contribution=<id>`.

`sort` is one of the legacy sort-dropdown options: `relevance` (score, then
newest), `recent` / `recent_asc` (contribution timestamp), `published` /
`published_asc` (`_reference.year`), `cited` (`_reference.n_citations`),
`citation_az` / `citation_za` (`_reference.citation`), `id_desc` / `id_asc`.
It may instead be `<column>:asc|desc`, a sortable column of the level's summary
grid (below): its header's sort, newest first on ties. Or `rows.<column>:asc|desc`,
the Rows grid's header sort on a raw row column: raw rows are not indexed, so it
orders the records by their rows' smallest (ascending) or largest (descending)
value of the column (`summary._all.<column>`, then the merged
`summary.<table>.<column>`; numerically for a data-model Number), and the SPA
orders each record's rows the same way — a record's rows stay together.

**Summary grid.** Each search level in `GET /config` carries `columns`, its
Summaries grid in order: `{key, cell, label, width, column?, subtitle_column?,
format?, sortable, filterable, facets, geospatial}`. `cell` names the tile (`record` — citation, then
title or the record's name, then date and contributor, one column filtered on
all of them; the default first column —, `citation`, `name`,
`contributed`, `download`, `links`, `counts`, `map`, `plot`, `geo` (the node
YAML's `search.geography` columns), `citations`, a tile an active plugin adds
(`sample-tiles`: `geology`, `age`, `intensity`, `method_codes`), or `field` /
`title` for a `column` of the level's summary block); `key` is the column
(field/title) or the tile. They come from the node YAML's
`search.levels[].columns` (admin Summary Grid tab), each unset field filled
from the tile's defaults (`fiesta.search.grid`, or the plugin's
`grid_tile_fields`), or the default tiles when a level sets none (the core's,
with the active plugins' default tiles before `citations`). A sortable
column sorts on a `.raw` keyword (numbers — data-model `Number` columns, a
plugin tile's number sort (age, intensity) — by a script that parses the string values; timestamp and id on
their typed fields). `filter=<key>:<text>` keeps the records whose filterable
column's text fields hold every typed word as a prefix (`simple_query_string`,
lenient); an unknown or unsortable/unfilterable key is a 422. A column's header
filter menu lists its `facets` (summary._all columns: geo → the geography
columns, citations, a plugin tile's (geology → classes / types / lithologies,
method_codes), and a `field` column whose data-model type is String or List → that
column) with the sidebar's checkbox lists: they filter through `<column>:"<value>"`
query tokens and are counted with `facet=<column>`. `filterable` (a text box,
`filter=`) is set only for a column without facets, or one configured with
`filter_fields`; `facets: []` in the YAML turns a column back into a text box.
`geospatial` marks the map tile of a level with positions, whose menu holds the
Map tab's area.

**Reference metadata.** `summary.contribution._reference` is the publication
behind a contribution's reference DOI (the `reference` column of its
contribution row, or set with `POST .../reference`), from Crossref or, for DOIs
Crossref doesn't know, DataCite, in the legacy shape: `source`, `doi` (upper
case), `title`, `journal`, `year`, `keywords`, `citation` ("Behar et al.
(2019)"), `authors` (`family`, `given`, `_name`, `affiliation`, `_orcid`),
`long_authors`, `n_citations`, `long_citation` (the full reference as text) and
`html`. Until its DOI is fetched (or when neither registry has it) it is just
`{doi}`. The worker fetches a DOI when a revision first names it and again every
30 days (so `n_citations` stays current), into the shared `doi_references`
table; indexing and `fiesta rebuild` read that table and never call out.
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
| PUT | `/{id}/reference` | `{doi, expected_revision, request_key}` | `ContributionOut` (a DOI the registries did not know is asked for again) |
| GET | `/{id}/reference` | | `{doi, status: none\|ok\|not_found\|error, citation, title}`: whether the DOI resolves at Crossref/DataCite, asked now when the cache does not know |
| GET | `/{id}/fields` | | `{column: cell}` for the node's `workspace.fields`, from the canonical file's `workspace.table` (`""` when empty) |
| PUT | `/{id}/fields` | `{values: {column: cell}, expected_revision, request_key}` | `ContributionOut` (sets those columns in the canonical file as a new revision; 422 for a column not in `workspace.fields`; unpublished only) |
| POST | `/{id}/activate` | | `ContributionOut` (publishes; requires `status=ready`, passing validation and, with `workspace.require_reference`, a DOI that resolves) |
| POST | `/{id}/deactivate` | | `ContributionOut` (unpublishes; node admins only, 403 otherwise: contributors correct published data with a new version) |
| PUT | `/{id}/name` | `{name}` | `ContributionOut` (the contributor's label, legacy `_name`; any version, published too; saves no revision; empty clears it) |
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

See [Revision management](#revision-management) below for the
concurrency and idempotency semantics of the mutating routes.

Every save of the canonical file (upload, `PUT /content`, a new version, the
`/v1` private append/replace, legacy import) writes its download-only
identifiers before storing it: the `contribution` table's `id`, and in every
other table that the data model gives the columns, `contribution_id` and a
`row_id` numbered 1..N across all the contribution's rows in file order.
Supplied values are overwritten, so a re-uploaded download is renumbered. A
file that does not parse is stored as sent. Both columns stay out of
`summary._all`. Files saved earlier are backfilled by `fiesta stamp-ids`
([storage-and-migration.md](storage-and-migration.md#existing-fiesta-data-and-legacy-migration)).

### Workspaces (`/v2/{repository}/workspaces`, Bearer or Basic)

Shared workspaces: owners control membership, editors save, viewers read.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v2/{repository}/workspaces` | | workspaces the caller owns, is a member of, or (admin) all — with the caller's `role` |
| POST | `/v2/{repository}/workspaces` | `{name}` | `{id, name}` (201) |
| PUT | `/v2/{repository}/workspaces/{workspace_id}/members` | `{user_id, role: "viewer"\|"editor"}` | `{role}` (owner only) |
| DELETE | `/v2/{repository}/workspaces/{workspace_id}/members/{user_id}` | | 204 (owner only) |
| PUT | `/v2/{repository}/workspaces/{workspace_id}/contributions/{contribution_id}` | | `{workspace_id}` (assign an owned contribution) |

### Data-source sync (`/v2/{repository}/source`, node admin)

A node in data-source mode (`FIESTA_CONTRIBUTIONS_MODE`, `contributions_mode` in
its config) refuses every write under `private/contributions` with a 409 and is
fed by its sync script instead. Details: [data-sources.md](data-sources.md).

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v2/{repository}/source` | | `{node, mode, source_id, kind, script, sync, synced, schedule, runs}` (the admin page's Data source tab) |
| GET | `/v2/{repository}/source/checkpoints` | | `{node, mode, source_id, checkpoints: {"<id>": "<fingerprint>"}}` |
| POST | `/v2/{repository}/source/runs` | `{started_at, finished_at, ok, trigger, summary}` | 201 (a sync script's run report) |
| POST | `/v2/{repository}/source/run` | | `{job_id, schedule}` (202; queued on the ops worker) |
| PUT | `/v2/{repository}/source/records/{id}` | multipart: `record` (SourceRecord JSON), `owner` (optional account JSON), files as `<revision key>/<name>` parts | `{id, status: "applied"\|"unchanged", fingerprint, bytes}`; 409 in public mode or when the record cannot apply |

### Plugins (`/v2/{repository}/plugins/{name}/...`)

Each plugin router mounts once per plugin. A request to a node that does not
activate that plugin (`features.plugins` in its YAML) is a 404. Plugin routes
read contribution data through `fiesta.plugins.util.load_visible_parsed` (or,
for a route that caches what it reads, `load_visible_contribution` before
loading), which enforces the same visibility rules as the core API.

| Method | Path | Plugin (node) |
|---|---|---|
| GET | `/v2/{repository}/plugins/poles/plate-boundaries` | `poles` (MagIC) — GeoJSON |
| GET | `/v2/{repository}/plugins/method-codes` | `method-codes` (MagIC) — `{<group>: {label, codes: [{code, definition, ...}]}}` (404 if the node has no codes file); was `/config/method-codes` until 2026-11-11 |
| GET | `/v2/{repository}/plugins/pmag-plots/contributions/{id}/{kind}` | `pmag-plots` (MagIC) — plot data, `kind` ∈ `demag`, `eqarea`, `arai`, `hyst`; counts are `summary.pmag_plots` of `GET /search/pmag_plots?contribution={id}` |
| GET | `/v2/{repository}/plugins/depth-plot/contributions/{id}/measurements` | `depth-plot` (CDR) |
| GET | `/v2/{repository}/plugins/plateau-calculations/contributions/{id}` | `plateau-calculations` (KArAr) — `{experiments: [{experiment, specimen, steps, ages, ...}], specimens: [{specimen, age, experiments, ...}]}`, every value as contributed; `?experiment=` or `?specimen=` narrows it (query params: names contain `/`); replaced `.../experiments/{name}/plateau` on 2026-11-12 |

## Search document shape

Search documents keep the legacy shape `{type, summary: {contribution, <level>,
_all}, rows}`. `summary._all` unions row values (capped 500/column) for
free-text search; the workflow flags `_is_activated` / `_is_latest` /
`_private_key` live in `summary.contribution`. Public reads are always
`_is_latest` and `_is_activated` unless a matching private key is supplied.

A level's doc is one named record, as in the legacy index: a contribution's
rows of that level sharing a name (its key column, `site` for sites) are one
doc, `rows` holding them all, `summary.<level>` their merge (each column's first
value) plus `_n_results`, how many rows (the level's `count_field`). A row
without a name is a doc of its own. So a level's matches count records (the
Summaries tab), and their summed `_n_results` its rows (the Rows tab).

Row values are text everywhere above (`summary.<level>`, `_all`), so every doc
also carries `summary._num` (2026-11-10): per data-model number column
(`Number`, `Integer`; not `contribution_id` / `row_id`) the sorted distinct
values of the record's rows as numbers, mapped as `double` — capped at 500 per
column but always keeping the least and the greatest; values that do not parse
are left out. The contribution doc's is the union across its levels (as its
`_all`). Columns a `search.unit_conversions` entry names are in its base unit:
MagIC's `age`, `age_low`, `age_high` are years BP by the row's `age_unit`
(factor, then offset: years AD → 1950 − year, which swaps low and high;
`age_sigma` only scaled), and a row whose unit has no factor leaves them out.
Range filters (`range=summary._num.age:0:5e6`) and histograms use these:

```json
"summary": {"sites": {"site": "HW01", "age": "2", "age_unit": "Ma", ...},
            "_num": {"age": [2000000.0], "dir_inc": [31.2, 33.0], ...}, ...}
```

A new or changed `_num` (or its `double` template) reaches an existing index
only through `fiesta rebuild`.

Every doc also carries `summary._has` (2026-11-10, the legacy "With … Data" /
"Without … Data" filters): per table, the sorted names of its data-model
columns with a value (not blank) in the doc's rows, mapped as `keyword` — the
columns the filter lists, in position order without the `downloadOnly()` ones
(the row stamps). The contribution doc's covers every table of the
contribution, those outside the hierarchy too (MagIC criteria, ages, images);
a record's covers its own table and those of the records below it that name
it (a location's: its sites', samples', specimens', measurements'), passed up
as the positions are. `summary._has._any` is the union of a doc's tables'.
Which tables a level offers is `NodeConfig.exists_tables`, served as the
config's `exists_tables` (`{<search table>: [_any?, <table>, ...]}`, `_any`
first when there are several): every data-model table but the contribution's
own on the contribution level, its own and the levels below on a level.

```json
"summary": {"_has": {"sites": ["int_abs", "lat", "lon", "site", ...],
                     "samples": ["azimuth", "dip", "sample", "site", ...],
                     "_any": ["azimuth", "dip", "int_abs", ...]}, ...}
```

`has=<table>:<column>` keeps the docs with data in that column of that table
(`terms` on `summary._has.<table>`); `has=!<table>:<column>` those that have
the table (`exists`) but no data in the column. Entries of one table and sense
are one filter whose columns are OR'd (with: data in any; without: lacking
any), separate filters AND — the legacy semantics. The table must be one the
level offers and the column a listed data-model column (else 422); a column
the table lacks matches no doc with data and every doc without. The SPA keeps
the entries in the URL's repeatable `has` param, applies those on the tables a
level offers to its results, map, filter-modal counts and level-tab count, and
keeps only those when switching levels. A new `_has` reaches an existing index
only through `fiesta rebuild`.

## Revision management

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
[Revision API contract and examples](storage-and-migration.md#revisions-and-apis) for details.

## Legacy v1 (api.earthref.org contract)

`/v1/...` is the API that `old-backend` served at api.earthref.org, ported onto
FIESTA's Postgres-owned contributions, revision service and search projection
(`fiesta/backend/fiesta/apps/routers/v1.py`). Its own OpenAPI document — the one the
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
  `reference_title` matches `summary.contribution._reference.title`, the
  reference DOI's publication metadata (see "Reference metadata").
