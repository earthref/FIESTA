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

- **Bearer token** — a HS256 JWT, sent as `Authorization: Bearer <jwt>`. People
  get one by signing in **without a password** (`fiesta.services.sign_in`):
  - *Emailed link*: `POST /v2/auth/email-link` mails a one-time link (15 min,
    `FIESTA_SIGN_IN_LINK_MINUTES`) back to the page it was asked from, with the
    secret in the URL fragment (`#fiesta_link=…`); `POST /v2/auth/email-link/verify`
    redeems it. The first use creates the account; every use verifies the address.
  - *External account* (Google, Microsoft, GitHub, ORCID; each offered once its
    `FIESTA_<PROVIDER>_CLIENT_ID`/`_SECRET` are set): `POST /v2/auth/oauth/{p}/start`
    gives the provider URL; the provider returns to `/v2/auth/oauth/{p}/callback`,
    which redirects to the starting page with a 2-minute hand-off code
    (`#fiesta_login=…&nonce=…`, or `#fiesta_login_error=…`) for `POST /v2/auth/exchange`.
    The SPA keeps the nonce in `sessionStorage` and ignores results from flows it
    did not start. A first sign-in joins the account with the same email only
    when the provider vouches for it (Google `email_verified`; a Microsoft
    personal account or `xms_edov`; a GitHub verified email; an ORCID public
    verified email) and creates an account only from such an address; ORCID also
    matches `users.orcid`. Anything else signs in by email first and connects
    the provider from the account page (`link: true`).

  `return_to` must be a page on a configured origin: `api.site_url`'s, a
  `FIESTA_CORS_ORIGINS` one, or a `FIESTA_SIGN_IN_ORIGINS` one (a copy of the site
  on another host, e.g. `["https://dev.earthref.org"]`); never the request's
  `Host`, which would let a forged header mail someone a link to another site. `POST /v2/auth/login` (OAuth2 password form) remains for
  scripts and service accounts (data-source syncs, `e2e.sh`); the SPA never offers it.
- **HTTP Basic** — EarthRef account email or handle + password. Kept for legacy
  `api.earthref.org` clients; the legacy routes accept Basic only, while the
  shared private-workspace routes accept either scheme.

**Publication profile.** Publishing (`POST .../activate`) needs the
contributor's first name, last name, affiliation and a verified email; until
then it answers 409 naming what is missing. `UserOut.profile_missing` lists the
same (`first_name`, `last_name`, `affiliation`, `verified_email`).

## Node-less routes

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/v2/health-check` | — | `{status, database, search, storage, repositories}` |
| GET | `/v2/authenticate` | Basic | `UserOut` (legacy Basic check) |
| GET | `/v2/auth/providers` | — | `{providers: [{id, name}], email_link: true}`: the external sign-ins configured here |
| POST | `/v2/auth/email-link` | — | 202 `{sent: true}`; body `{email, return_to}`; mails a one-time sign-in link (also signs up); the answer never says whether the account exists; at most 5 per address per link lifetime (more are silently dropped); 503 when SMTP fails |
| POST | `/v2/auth/email-link/verify` | — | `{access_token, ...}`; body `{token}` (the link's secret); 400 when expired or used. Creates the account on first use, marks the email verified, and applies an email change |
| POST | `/v2/auth/oauth/{provider}/start` | —/Bearer | `{url}` to send the browser to; body `{return_to, nonce, link}` (`link: true` connects the provider to the signed-in account; 401 without one); 404 for a provider not configured |
| GET | `/v2/auth/oauth/{provider}/callback` | — | 303 to `return_to#fiesta_login=<code>&nonce=…` or `#fiesta_login_error=<message>&nonce=…`; 400 page for an expired or foreign `state`. Each provider app registers `<FIESTA_OAUTH_REDIRECT_BASE or the public /v2 root>/auth/oauth/<provider>/callback` |
| POST | `/v2/auth/exchange` | — | `{access_token, ...}`; body `{token, nonce}` (the callback's hand-off code, single use, 2 minutes, and the nonce `start` was given). The account is linked or created here, never at the callback, so a flow finished in someone else's browser attaches nothing; 400 with the reason (an unverified email, an identity linked elsewhere, a wrong nonce, which also spends the code) |
| DELETE | `/v2/auth/identities/{provider}` | Bearer/Basic | 204; disconnects that provider (the emailed link always remains) |
| POST | `/v2/auth/email-change` | Bearer/Basic | 202; body `{email, return_to}`; mails a confirmation link to the new address, which becomes the account's (verified) when the link is redeemed; 409 when another account has it or while any served node is in data-source mode; 429 after 5 links |
| POST | `/v2/auth/login` | — | `{access_token, token_type: "bearer"}`; OAuth2 password form (`username`, `password`), for scripts and service accounts |
| GET | `/v2/auth/me` | Bearer/Basic | `UserOut` (with `first_name`, `last_name`, `affiliation`, `email_verified`, `profile_missing`, `sign_ins`) |
| GET | `/v2/auth/settings` | Bearer/Basic | the account's settings JSON object |
| PUT | `/v2/auth/settings` | Bearer/Basic | saved settings (body is a JSON object, capped at 16 KiB) |
| PATCH | `/v2/auth/me` | Bearer/Basic | `UserOut`; body any of `{first_name, last_name, affiliation, handle, name}` (the user's own account; `""`/`null` clears one; handle `[A-Za-z0-9_.-]{2,64}`); with both first and last names the display `name` becomes "first last". The email changes through `/email-change`, the ORCID iD only through connecting ORCID (or an admin); 409 on a handle another account has |
| POST | `/v2/auth/password` | Bearer/Basic | 204; body `{current_password, new_password}` (≥ 8 chars); 403 when the account has a password and `current_password` does not match. The password serves scripts and HTTP Basic only |
| POST | `/v2/auth/local-login` | — | `{access_token, ...}` or `null` — signs in `developer@example.test` only against local dev infrastructure, first creating the seed manifest's accounts on an unseeded stack (`null` elsewhere) |
| POST | `/v2/contact` | —/Bearer | 202 `{sent: true}`; body `{name, email, subject?, message, page?, repository?, screenshot?, website?}`: the "Having trouble? Email Us" form, mailed to `contact_email` (default webmaster@earthref.org) as `[<repository> Help] <subject>` with the sender as Reply-To, the page, browser and account, and `screenshot` (a PNG/JPEG/WebP data URL, ≤ 6 MB) attached; `website` is a honeypot (filled ⇒ dropped, still 202); 429 past 5 per sender or 60 per API process an hour; 503 when SMTP fails |
| GET | `/v2/basemap/{world\|arctic}` | — | JPEG: Esri Ocean as a 1024×512 plate carrée world image (blank past ±85.05°) and its Arctic band; fetched from Esri once a day and cached in the API process, for the result thumbnails |
| GET | `/v2/basemap/moon` | — | JPEG: the Moon (LROC WAC) as a 1024×512 plate carrée image, pole to pole, from USGS Astrogeology's WMS; cached the same way, for the thumbnails of records on the Moon |
| GET | `/v2/portal/users` | — | `{nodes, total, users: [{id, name, handle, orcid, counts, total}]}`: every user with a public contribution (activated, latest, not deleted) and how many they have per node; no email. Query `q` (every word in name/handle/ORCID), `sort` (`total`, a node slug, `name`, `handle`, `orcid`), `order` (`asc`\|`desc`), `offset`, `limit` (≤ 1000, default 100). The portal's Users page |
| GET | `/v2/portal/references` | — | `{nodes, total, references: [{doi, citation, title, journal, year, long_citation, counts, total}]}`: every reference DOI (normalized, upper case) a public contribution cites and how many cite it per node; the metadata from the `doi_references` cache, `null` until fetched. Same query parameters (`sort` also `citation`, `title`, `year`, `doi`; blanks sort last). The portal's References page |
| GET | `/v2/portal/stats` | — | `{nodes: {<slug>: {contributions, contributors, active}}}`: per web node, its public contributions, the distinct users who contributed them, and its latest, undeleted contributions (private workspace ones included, as a count only) created or revised in the last 182 days (imported revisions keep the source's timestamps); cached 5 minutes. The portal home's node buttons |
| GET | `/v2/portal/references/{doi}` | — | one cached DOI's `{reference, abstract?, openalex?, citations_by_year?, topics?, keywords?, open_access?}` (see "Search & retrieval", `summary.contribution._reference`); 404 until fetched. The contribution panel's Reference section |
| GET | `/v2/basemap/undersea-features` | — | GeoJSON `FeatureCollection` of the IHO-IOC GEBCO Gazetteer of Undersea Feature Names (NOAA NCEI's feature service), each `{name, kind: point\|line\|area}` with areas reduced to their middle point; fetched once a day and cached, for the Map tab's labels |
| GET | `/v2/basemap/plates` | — | GeoJSON `FeatureCollection` of Earth's present-day tectonic plates (Bird 2003, PB2002: 52 plates), each `{code, name}`, its polygons split at the antimeridian and closed over a pole where they circle one; served from the repo (`fiesta/backend/fiesta/data/plates.json`) with `Cache-Control: no-cache` and an ETag of its content (304 to a matching `If-None-Match`), so a changed file reaches browsers at once, for every map's plate boundaries and the Geospatial filter's plates |
| GET | `/v2/basemap/provinces` | — | GeoJSON `FeatureCollection` of the `plate_block` vocabulary's cratons, blocks and terranes that have a present-day outline (Hasterok et al. 2022's geologic provinces, Zenodo 10.5281/zenodo.6586972, CC-BY-4.0), each `{code, name, sources}`: `name` the vocabulary term, `code` its lower-case slug (`kaapvaal-craton`), `sources` the provinces and province groups it unites (`fiesta/scripts/province_terms.json`, built by `fiesta/scripts/provinces.py`); served and revalidated like the plates (`fiesta/backend/fiesta/data/provinces.json`), for the Geospatial filter's cratons and blocks |
| GET | `/v2/seo/head/{path}` | — | HTML fragment for the SPA shell's `<head>` (nginx SSI, `fiesta.apps.routers.seo`): `<title>`, description, canonical link and Open Graph tags for the SPA path as requested (`/MagIC/20907`, `/MagIC/search?contribution=20907`, `/MagIC/about`), plus JSON-LD: a public contribution's `Dataset` (as `/contributions/{id}/jsonld`), a node home's `DataCatalog`; `<meta name="robots" content="noindex">` off the `api.site_url` host and for private, unknown or account pages. Always 200 |
| GET | `/v2/seo/body/{path}` | — | HTML fragment inside the shell's root element: the same page as plain HTML for crawlers that run no JavaScript (a contribution's summary, a content page's text without markup, a node's links); React replaces it on start |
| GET | `/v2/robots.txt` | — | robots.txt (served at `/robots.txt`): crawlers and AI crawlers allowed, account routes disallowed, every served node's sitemap listed; `Disallow: /` off the `api.site_url` host |
| GET | `/v2/llms.txt` | — | llms.txt (served at `/llms.txt`, `text/markdown`): the repositories, each linking its own llms.txt |

The SEO routes name canonical URLs on `api.site_url` (fiesta.yaml), and API URLs under the
proxy's `X-Forwarded-Prefix` (the SPA base path) on the requesting host (`fiesta.apps.public_urls`).

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
| GET | `/v2/admin/nodes` | any admin | nodes the caller administers: `{slug, key, title, color, logo_svg, logo_style, served, published, draft, draft_is_stale, admins}` |
| POST | `/v2/admin/nodes` | super | new node as a draft only: `{slug, key, title, template}` copies the template node's data models and vocabularies |
| GET | `/v2/admin/nodes/{slug}` | node | the above plus `revisions` (history) and `plugins`: every plugin in the code as `{name, description, schema}` (the JSON schema of its options, defaults included; the Plugins tab switches a plugin on in `features.plugins` and edits its options under `plugins.<name>` through the settings PATCH) |
| PUT / DELETE | `/v2/admin/nodes/{slug}/admins/{user_id}` | node | grant / revoke a node admin |
| GET | `/v2/admin/nodes/{slug}/files?rev=` | node | the tree `{files: [{path, sha256}], changes: [{path, change}]}` (changes vs published) |
| GET | `/v2/admin/nodes/{slug}/file?path=&rev=` | node | `{path, revision, state, lock_version, size, encoding: utf-8\|base64, content}` |
| GET | `/v2/admin/nodes/{slug}/settings?rev=` | node | the node YAML parsed to JSON (the Pages and Search Filters tabs edit its `pages` and `search.filters` lists through the settings PATCH; page HTML is a file PUT to `<slug>/pages/<page>.html`) |
| PUT | `/v2/admin/nodes/{slug}/draft/file` | node | `{path, content, encoding?, lock_version?}` — write a file into the draft (JSON/YAML syntax checked) |
| DELETE | `/v2/admin/nodes/{slug}/draft/file?path=&lock_version=` | node | remove a file from the draft |
| PATCH | `/v2/admin/nodes/{slug}/draft/settings` | node | `{ops: [{path: [...], value}], lock_version?}` — edit the YAML keeping its comments; `value: null` deletes |
| PUT | `/v2/admin/nodes/{slug}/draft/logo` | node | `{content, lock_version?}` — the node logo SVG's text: sanitized (below) into `<slug>/assets/logo.svg`, and `node.logo` set to `logo.svg`, in the draft; 422 when it is not an acceptable SVG |
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

**Node logo.** `node.logo` names an SVG under `<slug>/assets/`, drawn as the
node tile (header, portal home cards, admin list, favicon;
`fiesta/frontend/src/components/node-mark.tsx`). `node.logo_style` is `tile`
(the default: framed, drawn in the node color darkened to 4.5:1 on white, with
`node.logo_label`, at most 12 characters and the key when unset, under it from
44px up) or `full` (the SVG as drawn, unframed). A tile logo is one color
(`currentColor`), with no stroke-width of its own on its shapes, and its viewBox
crops it: the crop sets how large it sits in the tile. The logo is sanitized
(`fiesta/backend/fiesta/svg.py`) on upload, when served (`logo_svg` in the
config) and again before the SPA inlines it: only `svg g path circle ellipse
rect line polyline polygon` and their geometry and presentation attributes
survive (no `style`, `class`, `id`, `href` or event handlers, no value with
`url(`, `javascript:` or `data:`), and a file over 100 KB, with a DOCTYPE or
entities, without a viewBox (or numeric width and height) or with nothing left
to draw is refused. Validation (and so publication) fails when `node.logo`
is missing or refused.

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
| GET | `/v2/{repository}/config/vocabularies/plugins` | the `cv()` lists active plugins supply (method codes): `{<name>: {label, case_insensitive, items: [{item, label}]}}`, `label` = the item's definition or null; the grid editor's pulldowns |
| POST | `/v2/{repository}/upgrade` | JSON `{text, unknown_columns?: keep\|drop, renames?: {"table.column": name}, defaults?: {key: bool}}` → `{upgraded, from_version, to_version, guessed, text, report, report_text}`: contribution text in an older data-model version upgraded to the latest (`fiesta.domain.upgrade` + the active plugins' `upgrade_steps`), or `upgraded: false` (text and report null) when it is already in the latest version or in none the node knows. The version is the contribution table's `data_model_version`/`magic_version`, else guessed from the tables and columns. `report`: `{steps, notes: [{level, kind, message, step, table, column, to, count}], defaults: [{key, label, on, count, step}], rows_in, rows_out}` — kinds `renamed`, `merged`, `dropped_column`, `dropped_value`, `dropped_row`, `dropped_table`, `unknown_column`, `unknown_table`, `converted`, `conversion`, `merged_rows`, `collision`, `version`. Columns and tables the old model does not define are kept under their own names unless `unknown_columns` is `drop`; `renames` apply before upgrading (`""` drops a column); `defaults` switches the old model's blank defaults. Stateless (nothing is stored) but a contributor action: Bearer or Basic auth (401 without), the body capped at the upload limit (`FIESTA_MAX_UPLOAD_BYTES`, 512 MiB like the SPA's nginx; 413 over it, by `Content-Length` before reading or while a chunked body streams), and the conversion runs in a worker thread; 422 when the text does not parse |
| GET | `/v2/{repository}/import-formats` | → `[{key, label, description, extensions, multi_file, example, plugin, options_schema}]`: file formats the active plugins convert to the node's text format in the upload page's import step (`FiestaPlugin.import_formats`, `fiesta.services.import_formats`; MagIC's lab instrument formats are the `pmag-lab-formats` plugin). `options_schema` is the format's options model's JSON schema (an enum may carry `x-enum-labels`); `example` the names of its example files (the one read as the format first), or `[]`. Public |
| GET | `/v2/{repository}/import-formats/{key}/example/{name}` | → one of a format's example files (`application/octet-stream`), which the upload page's Step 1 offers to try or download. 404 for a format the node does not have or a name not in its `example`. Public |
| POST | `/v2/{repository}/import-formats/sniff` | JSON `{files: [{name, head}]}` (`head`: the file's first 16 KB, base64; up to 1000 files) → `{auto_pick, files: [{name, format, confidence, companion_of}]}`: per file, the format most sure of it (`confidence` 0–1; the import step picks it at `auto_pick`, 0.8, or more) and, for a file a confident multi-file format reads with another (a CIT `.sam` file's specimen files), that file's name. Public; capped at 24 MB |
| POST | `/v2/{repository}/import-formats/{key}/convert` | JSON `{files: [{name, data}], options?}` (`data` base64; the file read as this format first, then the companions it reads; `options`: only those the contributor set) → `{format, label, plugin, files, tool: {name, version, function}, options, options_set, text, tables: {table: rows}, hierarchy: [{table, count}], notes: [{level, kind, message, count}], report_text}`: the files converted in a temporary directory, in a worker thread; `text` is the node's multi-table text the import step reads as its sheets, `hierarchy` the row counts of the node's hierarchy tables, `notes` kinds `converter` (what the converter printed), `default` (an option left at a default that shapes the result), `hint` (e.g. every specimen its own sample and site), and `report_text` the report the upload page keeps beside the originals (`<name>-conversion-report.txt`). Stateless but a contributor action: Bearer or Basic auth (401 without), capped at the upload limit (413), 404 for a format the node does not have, 422 for options that do not fit the schema or a failed conversion (the detail names the converter's error and first warnings) |

`GET /v2/{repository}/config` response:

```json
{
  "key": "MagIC",
  "slug": "magic",
  "title": "Magnetics Information Consortium (MagIC)",
  "subtitle": "...",
  "color": "#800080",
  "logo": "logo.svg",
  "logo_svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"2 2 20 20\" ...>...</svg>",
  "logo_style": "tile",
  "logo_label": null,
  "links": {"website": "...", "github_issues": "..."},
  "data_model_versions": ["2.2", "2.3", "2.4", "2.5", "3.0"],
  "data_model_latest": "3.0",
  "search_levels": [
    {"name": "Contributions", "table": "contribution", "count_field": null, "geo": true},
    {"name": "Locations", "table": "locations", "count_field": "summary.locations._n_results", "map": true, "geo": true},
    {"name": "Measurements", "table": "measurements", "count_field": "summary.measurements._n_results", "map": false, "geo": true}
  ],
  "facets": ["method_codes", "geologic_classes"],
  "filters": [
    {"type": "facet", "field": "method_codes", "label": null, "levels": [], "views": ["Summaries", "Data"], "unit": null, "scale": 1.0, "min": null, "max": null},
    {"type": "range", "field": "summary.poles.age", "label": "Age", "levels": ["Locations"], "views": ["Poles"], "unit": "Ma", "scale": 1000000.0, "min": null, "max": null},
    {"type": "bbox", "field": null, "label": "Geospatial", "levels": ["Locations"], "views": ["Poles"], "unit": null, "scale": 1.0, "min": null, "max": null}
  ],
  "pinned_filters": [
    {"levels": [], "views": [], "filters": ["Age", "Geospatial", "Author", "Contributor"]},
    {"levels": ["Locations"], "views": ["Poles"], "filters": ["Age", "Pole A95", "Geospatial"]}
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
  "map_level": "Sites",
  "quick_launch": null,
  "plugins": {"poles": { /* frontend_config per active plugin */ }, "method-codes": {"has_codes": true}},
  "deployment_nodes": ["MagIC", "KdD", "CDR", "KArAr", "ERDA", "OSU-MGR"],
  "hidden_nodes": ["OSU-MGR"]
}
```

`search_levels[].geo` is true for a level whose rows carry a position (the area
filter narrows it); `map` is the node YAML's `search.levels[].map`, false for a
geo level that gets no Map tab and no layer on a contribution's Map tab (MagIC's
measurements, whose positions only repeat their specimens'). `default_view` is
the YAML's `search.levels[].default_view` (`Summaries`, `Data` or `Map`; null:
Summaries, and the level tab keeps the open sub-tab).

`map_level` is the level the quick-launch Map button opens (the YAML's
`search.map_level`, else the first record level with a map; null when no level
has one) and `quick_launch` the YAML's `search.quick_launch`, the buttons'
names in order (null: Map, then every plugin view the node has).

`filters` are the node YAML's `search.filters`: the sidebar controls, each
restricted to the search `levels` and result `views` (Summaries, Data, a plugin
tab) it names, empty meaning all (a legacy `Rows`, the Data view's name until
2026-11-16, is read and served as `Data`). `facets` lists the facet filters' fields (what
`facets=true` aggregates; the pre-2026-09 YAML key `search.facets` still loads as
facet filters).

`pinned_filters` are the node YAML's `search.pinned_filters`: the filters the
sidebar keeps at its top, in order, whatever their counts (one with no values
shows, disabled). Each rule applies on the `levels` and `views` it names (empty:
any; `Rows` is read as `Data`); where several match, the SPA takes the most
specific (naming views counts 2, naming levels 1) and the first of equals. A
name matches a sidebar entry's label or key in any case ("Age", "Geospatial",
"With Data", a data-model column's label, a plugin filter's label such as
"Periodic Table of Elements"); one matching none is skipped. The
loader refuses an empty `filters`, a blank name, a name twice in one list (in
any case) and a level the node does not have.

`map_colors` are the node YAML's `search.map_colors`, what the
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
| GET | `/v2/{repository}/search/{table}` | `query` (free text / `term:"value"` tokens), `size` (default 10, 1–1000), `from`, `facets` (bool), `facet` (repeatable column: aggregate these instead of the sidebar's facets — a sidebar facet, a text column of the level (the `text` filter's), or a facet of the level's grid columns, else 422; `id`, `contributor` and `author` aggregate the contribution block's `summary.contribution.id` / `_contributor.raw` / `_reference.authors._name.raw`, keys always strings), `facet_size` (values per facet, default 100, 1–2000; a filter modal asks for the whole list), `range` (repeatable `field:gte:lte`), `bbox` (`minLon,minLat,maxLon,maxLat`), `plate` (repeatable, or comma separated: a plate code from `/v2/basemap/plates`, e.g. `PA`, or a province code from `/v2/basemap/provinces`, e.g. `kaapvaal-craton`: a position on any of them; with `bbox`, both apply; unknown codes 422), `sort` (see below), `filter` (repeatable `<column>:<text>`, see below), `has` (repeatable `[!]<table>:<column>`, see below), `contribution` + `private_key?` (see below), `mine?` / `versions?` (scope, see below), `totals` (bool, see below), `source` (repeatable `summary.<block>.<name>`, 1–50: each result holds only those fields, for a view paging through thousands of matches) | `SearchPage` |
| GET | `/v2/{repository}/search/{table}/extent` | `query`, `range`, `filter`, `has`, `contribution`, `private_key?`, `mine?` / `versions?` | `{total, bounds?, center?}`: where the matches with a position on Earth are, without fetching them: `bounds` `[west, south, east, north]` (a geo_bounds; west is east of east across the antimeridian) and `center` `[lon, lat]`, the centroid of the busiest zoom-4 geotile (~22.5°); both absent when none is positioned; 404 for a level without positions (the Geospatial filter's default area, at most 20° each way) |
| GET | `/v2/{repository}/search/{table}/points` | `query`, `range`, `bbox`, `plate`, `filter`, `has`, `contribution`, `private_key?` (as above), `color_by?` | `MapPoints` — a public search's response (no `mine`, no private key) is kept per API process until the node's index changes (its name, index/delete totals and refreshes; `fiesta.search.cache`), or 60 s where the role may not read index stats |
| GET | `/v2/{repository}/search/{table}/values` | `field` (repeatable, 1–50, `summary.<block>.<name>`), `query`, `range`, `bbox`, `plate`, `filter`, `has`, `contribution`, `private_key?` | `SearchValues` |
| GET | `/v2/{repository}/search/{table}/histogram` | `field` (a numeric `summary.<block>.<name>`, else 422), `bins` (1–200; default from how many values there are, 2·n^⅓ between 10 and 100), `log` (bool), `query`, `range`, `bbox`, `plate`, `filter`, `has`, `contribution`, `private_key?` | `SearchHistogram` |
| GET | `/v2/{repository}/search/{table}/numbers` | `query`, `range`, `bbox`, `plate`, `filter`, `has`, `contribution`, `private_key?` | `{total, columns: {<column>: n}}` — the level's number columns (`summary._num.<column>`, data-model order) and how many matches have a value of each, zeros included (the `numeric` filter's column picker) |
| GET | `/v2/{repository}/search/{table}/filters` | `count` (repeated: `geo`, `bbox`, `plate`, `numeric`, `exists`, `facet:<column>`, `range:<path>`, or `text:*` / `numeric:*` for a `facet:<column>` / `range:summary._num.<column>` key per text / number column of the level; else 422), `query`, `range`, `bbox`, `filter`, `has`, `contribution`, `private_key?` | `{total, counts: {<key>: n}}` — of the matches, how many have a value for each sidebar filter (a position, any number column, any recorded table, the facet's column, the range's field), zeros included: the count beside each filter in the search sidebar, which hides a filter at zero (and lists the `text` / `numeric` filters' columns by the keys `text:*` / `numeric:*` return) |
| GET | `/v2/{repository}/search/{table}/has` | `of` (one of the level's `exists_tables`, else 422), `query`, `range`, `bbox`, `plate`, `filter`, `has`, `contribution`, `private_key?` | `{total, with_table, columns: {<column>: n}}` — of the matches, how many have the table `of` and how many have a value in each of its columns (data-model order, zeros included); those without a column are `with_table` − n (the `exists` filter's modal; the caller leaves `of`'s own `has` entries out) |
| GET | `/v2/{repository}/search/{table}/download` | `tables` (repeatable search levels below the contribution, else 422) or `files` (bool), `format` (`txt` default, or `json`), `query`, `range`, `bbox`, `plate`, `sort`, `filter`, `has`, `mine?` / `versions?` | the search page's Download Results (an attachment, `<Key> Download - <UTC stamp>.<ext>`). With `tables`: each level's matching rows as one table (every row of each matching record, `citations` "This study" replaced by its contribution's reference), after a `contribution` row naming the latest data model, in the node's text format or as JSON `{<table>: [row, …]}`, at most 200,000 rows. With `files`: the first 100 matching contributions' files (at most 512 MB of text), in the search's order, as `<id>/<slug>_contribution_<id>.txt|json` in a zip. `table` is the open level: every level is searched as its tab counts it (the query, `bbox` where it has positions, the `has` entries on its tables), and `table` also takes `range`, `filter` and `sort`. A capped download sets `X-Download-Truncated` (e.g. `100 of 240 contributions`); 404 when nothing matches |
| GET | `/v2/{repository}/contributions/{id}` | `private_key?` | Contribution summary doc |
| GET | `/v2/{repository}/contributions/{id}/download` | `private_key?` | canonical text file (`text/plain` attachment) |
| GET | `/v2/{repository}/sitemap.xml` | | sitemap (served at `/<Key>/sitemap.xml`): the node's home, search and listed pages, and every public contribution page (`<site_url>/<Key>/<id>`, `lastmod` its last update), at most 50,000 URLs |
| GET | `/v2/{repository}/llms.txt` | | llms.txt (served at `/<Key>/llms.txt`, `text/markdown`): what the node holds, how many public contributions, how to search, download and read them through the API, its data model and pages |
| GET | `/v2/{repository}/contributions/{id}/jsonld` | `private_key?` | the contribution as a schema.org `Dataset` (`application/ld+json`, after Science-on-Schema.org; `fiesta.domain.jsonld`): `@id`/`url` its landing page `<api.site_url>/<Key>/<id>`, the DOI `<doi.prefix>/<id>` (activated only), creators with ORCIDs and the cited article from the reference, keywords from vocabulary columns, `spatialCoverage` (bounding box + points), `temporalCoverage` (years BP), `variableMeasured` (data-model label/unit, min/max from `summary._num`), provider/license from the node YAML's `jsonld` block, `funding` (MonetaryGrants) from its `jsonld.funding_column`, the download under the proxy's `X-Forwarded-Prefix`, and what active plugins add (`FiestaPlugin.jsonld`; method-codes: `measurementTechnique` as defined terms); the contribution modal's admin-only JSON-LD tab, and the contribution page's head (`/v2/seo/head`) |
| GET | `/v2/{repository}/contributions/{id}/versions` | `private_key?` | the `previous_id` chain, oldest first: every published version plus this one — `[{id, version, data_model_version, timestamp, contributor, is_activated, is_latest}]` |
| GET | `/v2/{repository}/contributions/{id}/rows` | `private_key?` | per-table row stats — `{validated, previous: {id, version} \| null, rows: {<table>: n}, tables: {<table>: {errors?, warnings?, changed?, removed?}}}`: `rows` counts the file's rows in every table it holds (the modal's tabs for tables no search level indexes), distinct rows the current revision's validation flagged, and rows added/edited (`changed`) or dropped (`removed`) since the previous published version, ignoring the stamped `row_id`/`contribution_id` (the contribution modal's level-tab badges) |
| GET | `/v2/{repository}/contributions/{id}/tables/{table}` | `private_key?`, `sort?` (`<column>:asc\|desc`), `from?`, `size?` (≤1000, default 100) | one page of a data-model table of the contribution's current file, in file order or sorted over the whole table (numbers numerically, blanks last) — `{total, columns, validated, column_issues: {<column>: {severity, messages}}, rows: [{row, values, issues: {<column> \| "": {severity: error\|warning, messages}}}]}`; `row` is the 1-based position in the file's table that validation issues name, `""` an issue on the whole row (the contribution modal's level tabs; 404 for a table not in the data model, no rows for a file without it) |
| GET | `/v2/{repository}/contributions/{id}/tables/{table}/locate` | `values` (a row as a JSON object), `private_key?` | where a search doc's row sits in the file's table — `{row}`, the 1-based position of the first row whose named columns all equal `values` as text (blank matching blank), or null (the search page's Data grid opening the modal on that row) |
| GET | `/v2/{repository}/contributions/{id}/rows/{row_id}` | `private_key?` | where a persistent row link points — `{table, row}`: the table holding the row with that core `row_id` and its 1-based position there; 404 when no row has it. Every row of a contribution outside its `contribution` table has a core `row_id`, 1..N across the file in file order, whatever its data model declares (`ParsedContribution.row_ids`): table pages return it per row (`row_id`), search docs' `rows` carry it, and `stamp_ids` writes the same number where the data model has a `row_id` column. The SPA's `/<Node>/<id>.<row_id>` (a row) and `/<Node>/<id>.<row_id>.<column>` (a data point: that row's column) open the modal's level tab on the row, the column's cell outlined; the Data grid and the modal's level tabs show each row's number, `<id>.<row_id>`, as a button that copies that link |

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
position (levels whose `geo` is true): the search page's Data and Map sub-tab
counts. Otherwise both are null. Each facet bucket likewise carries
`rows_count` (levels with a `count_field`) and, with `totals` on a `geo` level,
`mapped_count`, so the sidebar's facet counts follow the active sub-tab; a
plugin view's sub-tab takes its facets from a `facets=true` search of its own
table.

`query` tokens (every search endpoint): `<column>:"<value>"` matches
`summary._all.<column>.raw` exactly, `||` OR-ing values within a token and
tokens AND-ed; a value with a `*` is a wildcard matched ignoring case
(`site_name:"*kenya*"`, a name containing "kenya"; not on the contribution-block
terms `id`, `doi`, `contributor`, `orcid`, `author`, `private_key`). `author`
(2026-11-23) is the contribution's reference authors as cited
(`summary.contribution._reference.authors._name.raw`, `author:"A. Koppers"`),
every node's Author filter.
`radius:"<lat>,<lon>,<km>"` (2026-11-14) matches docs with a position
(`summary._all._geo_point`) within that great-circle distance of the centre
(OpenSearch arc distance, capped at π·6371 km; longitude −360..360, wrapped);
a malformed one matches nothing. The GEOMAGIA site's radius search is the
`geomag-series` plugin's sidebar control for it.

```json
MapPoints = {
  "total": 410,
  "points": [{"id": 106, "name": "S106-0", "lat": 0.07, "lon": 175.9, "count": 12?, "value": 1.5e6?, "body": "moon"?,
              "parents": [{"table": "locations", "name": "L1"}]?}],
  "truncated": false,
  "contributions": {"106": {"citation": "Smith et al. (2020)"?, "contributor": "@smith"?, "timestamp": "2020-01-02T00:00:00Z"?}}
}
```

`parents` names the rows above a point's (its hierarchy levels below the
contribution, top first) that its search doc carries, from their summary block
or `summary._all`; `contributions` labels every point's contribution (its
`_reference` citation, `_contributor` and `timestamp`) for the map's tooltips.

`points` is every match with a `summary._all._geo_point` or `_body_point`, up
to 50,000 (`truncated` past that), for the search page's Map tab: `id` is the
contribution, `name` the row's own key column (`sites` → `site`; absent at the
contribution level), `body` the planetary body a point on another one is on
(`moon`; absent on Earth). A doc with several positions (a
contribution; an area such as a location, mapped at its sites' and samples'
positions rather than drawn as its box) gives a point per position it carries
(only those inside `bbox` and on a `plate`, when given: both are on Earth,
so either leaves out the points on other bodies). `{table}` must be a level whose
`geo` is true, otherwise 404.

Past 10,000 matches at a level of single points (not the contribution level,
not an area level; scoped to one `contribution` too), `points` are the
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
values `log` comes back false and the bins are linear. A bin counts the docs
with a value in it, so a multi-valued doc counts in each bin it has values in;
`counted` is how many docs have a value at all, each once (2026-11-16: it was
the bins' sum, which could pass `total`). An interval's histogram
(`field=summary._interval.<name>.range`) takes its extent from the block's
`values` and counts in each bin the docs any of whose intervals overlaps it —
a `filters` aggregation of the same `intersects` range query its filter runs,
so a 10 ± 5 Ma age fills every bin from 0 to 20 Ma, not only those at its
ends and best estimate. A field no match has has no bins, and a text field (row values
are strings) is a 422 — a data-model number column's histogram is on its
`summary._num.<column>`. Field rules and visibility are as for `values`.
A `range` on a multi-valued field (`summary._num`) matches a doc with any value
inside it. The date field `summary.contribution.timestamp` (Contributed On)
works the same in epoch milliseconds (a `range`'s bounds are rounded to whole
milliseconds; its histogram has no `log`, `positive_min` null).

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
the Data grid's header sort on a raw row column: raw rows are not indexed, so it
orders the records by their rows' smallest (ascending) or largest (descending)
value of the column (`summary._all.<column>`, then the merged
`summary.<table>.<column>`; numerically for a data-model Number), and the SPA
orders each record's rows the same way — a record's rows stay together.

**Summary grid.** Each search level in `GET /config` carries `columns`, its
Summaries grid in order: `{key, cell, label, width, column?, subtitle_column?,
format?, show?, lines?, sortable, filterable, facets, geospatial}`. `cell` names the tile (`record` — citation, then
title or the record's name, then date and contributor, one column filtered on
all of them; the default first column —, `citation`, `name`,
`contributed`, `download`, `links`, `counts`, `map`, `plot`, `geo` (the node
YAML's `search.geography` columns), `citations`, a tile an active plugin adds
(`sample-tiles`: `geology`, `age`, `intensity`, `method_codes`), `field` /
`title` for a `column` of the level's summary block, or `fields` for up to 5
data columns under one header, a "Label: value" line each); `key` is the column
(field/title), the `fields` columns joined by `-`, or the tile. A `field` /
`fields` column's `lines` are `{column, label, unit?, number, scale?}` (the
data-model label and display unit — "°", "Am²" — unless the YAML line sets
them; a number is divided by `scale`), and `show` says what a record shows of
each: absent or `value`, its own (first row's) `summary.<table>.<column>`;
`values`, every distinct `summary._all.<column>` (on Contributions the whole
contribution's, any table's column); `range`, least – greatest of
`summary._num.<column>` (a unit conversion's columns in its base unit), sorted
by script on those doubles and not text-filterable. A plain `field` without
`show` shows the value as typed, without a unit. They come from the node YAML's
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
7 days (so `n_citations` stays current), into the shared `doi_references`
table; indexing and `fiesta rebuild` read that table and never call out.
OpenAlex is asked for the same DOI: its ORCIDs fill in authors the registry
gives none, and `n_citations` is the larger of the registry's and OpenAlex's
counts. The rest of the OpenAlex work stays out of the search docs (every row
of a contribution carries `_reference`) and is served by
`GET /v2/portal/references/{doi}`: `{reference, abstract?, openalex?,
citations_by_year?: [{year, count}], topics?, keywords?, open_access?: {url,
status}}`, the abstract from the registry or else OpenAlex; 404 until the DOI
is fetched. `FIESTA_OPENALEX_API_KEY` is sent when set.
Where a registry's record is wrong (a publisher deposit with U+FFFD for an
accented letter), `configurations/references/corrections.yaml` overrides its
title, journal, year, volume, issue or page for every node; `fiesta init`
re-applies the file to the cached references and their search docs.
When omitted the API sorts by relevance if the query has free text and by
`recent` otherwise.

### Saved searches (`/v2/{repository}/searches`)

The search page's URL is `/<Key>/Search/<level>/<view>?q=<id>`: the level and
result view are path segments, and everything else is a saved search's
`state` — `{query?, sort?, ranges?, filter?, has?, bbox?, area?, plates?,
mine?, versions?, settings?}` (the search request params above, `query` the
free text and tokens; `settings` maps `"<owner>.<name>"` view settings such as
`map.color` or `poles.vgps` to any JSON). The id is a UUIDv5 of the node and
the state's canonical JSON (`fiesta.services.searches`), so the same search
always gets the same id and a saved search is never changed. Rows live in each
node's schema (`searches`, and `search_uses`: one row per save or open, with
the user if signed in and the level and view it was on).

| Method | Path | Auth | Body / params → returns |
|---|---|---|---|
| POST | `/v2/{repository}/searches` | optional | `{state, level?, view?}` → `{id, state, created_at}` (the canonical state; empty fields dropped, unknown fields 422, over 16 kB 413) |
| GET | `/v2/{repository}/searches/{id}` | optional | `level?`, `view?` → `{id, state, created_at}`; counts as an opening; 404 if unknown |
| GET | `/v2/{repository}/searches/usage` | node admin | `days` (default 30), `limit` (default 50) → `{days, uses, searches, users, levels: [{level, view, uses}], keys: [{key, uses}], top: [{id, state, uses, users, last_used_at}]}`: the admin page's Searches tab |

A link from before the saved searches (`/MagIC/search?q=basalt&level=Sites`,
`?contribution=16901&tab=sites`) is saved and redirected by the SPA.

### Private workspace (`/v2/{repository}/private/contributions`, Bearer or Basic)

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `` | | `ContributionOut[]` (the caller's own work, newest first: contributions they made or that are in a shared workspace they own or belong to. Node admins too: other people's contributions on the node are not listed, though an admin may still open and act on any of them by id, as the Requests tab's cards do) |
| POST | `` | | `ContributionOut` (201; allocates `id` + `private_key`) |
| GET | `/{id}` | | `ContributionOut` |
| PUT | `/{id}/file` | multipart `file`; headers `Idempotency-Key` (required), `If-Match` (revision; omit only for the first upload) | `ContributionOut` (stores file, enqueues processing). A file in an older data-model version is stored upgraded to the latest (as `POST /upgrade`, undefined columns kept), with the file as uploaded and `upgrade-report.txt` as attachments |
| POST | `/{id}/import` | multipart `data` (contribution text, one block per imported sheet, as the upload page converts it) + `originals` (0..n files as uploaded); headers `Idempotency-Key` (required), `If-Match` (the revision the upload was prepared against; omit only for the first upload) | `ContributionOut`. The upload page's save: values are normalised against the latest data model (Integer `3.0` → `3`; controlled-vocabulary terms re-cased, a one-letter typo corrected when unambiguous, `t`/`1`/`yes` → `True` in a True/False vocabulary), each table it brings **replaces** that table of the contribution and the others are kept (in `workspace.table`, the contribution's workspace fields and `reference` survive where the upload leaves them blank), and the originals become attachments of the new revision (`original-<name>` when one is named like the canonical file). Text in an older data-model version is upgraded first and `upgrade-report.txt` joins the attachments (the upload page upgrades as it reads a file and sends the report as an original). 422 when the text does not parse, has no rows, or brings a `upload.single_source_tables` table from two sheets; 409 when `If-Match` is not the head |
| POST | `/{id}/validate` | | `{job_id}` (async validation; a Postgres outbox event id) |
| GET | `/{id}/validation` | | `ValidationResult` (404 if never validated) |
| PUT | `/{id}/reference` | `{doi, expected_revision, request_key}` | `ContributionOut` (a DOI the registries did not know is asked for again) |
| GET | `/{id}/reference` | | `{doi, status: none\|ok\|not_found\|error, citation, title}`: whether the DOI resolves at Crossref/DataCite, asked now when the cache does not know |
| GET | `/{id}/fields` | | `{column: cell}` for the node's `workspace.fields`, from the canonical file's `workspace.table` (`""` when empty) |
| PUT | `/{id}/fields` | `{values: {column: cell}, expected_revision, request_key}` | `ContributionOut` (sets those columns in the canonical file as a new revision; 422 for a column not in `workspace.fields`; unpublished only) |
| POST | `/{id}/activate` | | `ContributionOut` (publishes; requires `status=ready`, passing validation, the contributor's complete publication profile (first and last name, affiliation, verified email; 409 naming what is missing) and, with `workspace.require_reference`, a DOI that resolves). Who may: see [Publishing a new version](#publishing-a-new-version); 403 for anyone else ("an admin has to approve this version"); 409 when another version of the same predecessor was published first. Publishing someone else's draft keeps them its contributor and emails them |
| POST | `/{id}/deactivate` | | `ContributionOut` (unpublishes; node admins only, 403 otherwise: contributors correct published data with a new version) |
| PUT | `/{id}/name` | `{name}` | `ContributionOut` (the contributor's label, legacy `_name`; any version, published too; saves no revision; empty clears it) |
| DELETE | `/{id}` | | 204 (private, unactivated only) |
| GET | `/{id}/download` | `revision_id?` | the canonical file (`text/plain`, `Content-Disposition: attachment` with its name) for anyone who may open the contribution here; 404 before the first upload |
| PUT | `/{id}/contributor` | `{user}` (email or handle, any case, `@` optional) | `ContributionOut` (reassigns a private contribution: its contributor or a node admin only, 403 for a shared workspace's editor; 404 for an unknown account, 409 if published or already theirs; records a `reassign` audit event and re-indexes, no revision) |
| GET | `/{id}/content` | `revision_id?` | `{revision_id, text}` (canonical file text) |
| PUT | `/{id}/content` | `{text, expected_revision, request_key}` | `ContributionOut` (JSON edit) |
| GET | `/{id}/revisions` | | revision history `[{id, parent_id, actor_id, operation, created_at, files}]` |
| POST | `/{id}/revisions/{revision_id}/restore` | `{expected_revision, request_key}` | `ContributionOut` |
| GET | `/{id}/revisions/{revision_id}/validation` | | validation reports recorded against that revision |
| GET | `/{id}/attachments` | | `[{name, size, sha256}]` (non-canonical files) |
| GET | `/{id}/attachments/{name}` | `revision_id?` | file bytes (`application/octet-stream`) |
| PUT | `/{id}/attachments/{name}` | multipart `file`; `Idempotency-Key` + `If-Match` headers | `ContributionOut` |
| DELETE | `/{id}/attachments/{name}` | `{expected_revision, request_key}` | `ContributionOut` |
| POST | `/{id}/versions` | | `ContributionOut` (201; the caller's private draft of the next version). Anyone signed in, from the latest version of a published contribution; those who may save the original also from a withdrawn one, and their draft joins its shared workspace and keeps its name. 409 when a later version exists, 404 for a private contribution the caller cannot save |

```json
ContributionOut = {
  "id": 20001,
  "version": 1,
  "previous_id": null,
  "contributor_id": 1,
  "contributor_name": "...",       // the owner, on every workspace card
  "contributor_handle": "..." | null,
  "private_key": "uuid",            // only present for the owner or an admin
  "can_publish": true,              // private workspace: whether the caller may publish it once it validates
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

#### Publishing a new version

Anyone signed in may prepare the next version of a published contribution
(`POST /{id}/versions`); the draft is theirs. It is published
(`POST /{id}/activate`, once it validates) by:

| Caller | First version (no `previous_id`) | Later version |
|---|---|---|
| Its contributor | yes | only if they contributed an earlier version of the chain |
| A shared workspace's editor | yes | only if they contributed an earlier version |
| A contributor of any earlier version (the chain linked by `previous_id`) | — | yes, if they can open the draft (theirs, or shared with them) |
| A node admin of the node (`is_node_admin`), or a super admin | yes | yes: it stays the drafter's, who joins the chain |
| Anyone else | 404 | 404 (a private draft they cannot open) |

`ContributionOut.can_publish` says which applies to the caller; a drafter outside
the chain sees "An admin has to approve this version" and asks for it with an
assistance request (reason `approve`).

### Assistance requests (`/v2/{repository}/private/...`, Bearer or Basic)

A user asks the node's admins for help with one of their contributions. Node
admins can already open every contribution of their node (`can_access`); an open
request puts it on their Requests tab and grants nobody else anything. Postgres
table `assistance_requests` (node schema); `request-open`, `request-withdraw`
and `request-resolve` audit events; emails through the `send_email` queue to the
node's admins (super admins when the node has none) on open and to the requester
on resolve. Writes are refused in data-source mode, like the rest of the workspace.

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/private/requests` | `scope=mine` (default) \| `node`, `state=all` (default) \| `open` | `RequestOut[]`, newest first. `mine`: requests the caller made or on their contributions. `node`: every request on the node's contributions, each with `contribution` (`ContributionOut` as the caller sees it) and `validation` (`{is_valid, errors, warnings, validated_at}`, counts); node admins only, 403 otherwise |
| GET | `/private/contributions/{id}/requests` | | the contribution's `RequestOut[]`, for whoever may open it (404 otherwise) |
| POST | `/private/contributions/{id}/requests` | `{reason: approve\|reassign\|validation\|other, message}` | `RequestOut` (201); whoever may save the contribution; 409 when it already has an open request; emails the node's admins |
| POST | `/private/requests/{request_id}/withdraw` | | `RequestOut` (`state: withdrawn`); the requester or the contribution's contributor (403 for an admin, 404 for anyone who cannot see it); 409 unless open |
| POST | `/private/requests/{request_id}/resolve` | `{note}` | `RequestOut` (`state: resolved`, the note); node admins only (403); 409 unless open; emails the requester |

```json
RequestOut = {
  "id": 1, "contribution_id": 20001,
  "requester_id": 7, "requester_name": "...", "requester_handle": "..." | null,
  "reason": "approve|reassign|validation|other", "message": "...",
  "state": "open|withdrawn|resolved",
  "created_at": "...", "closed_at": null, "closed_by": null, "closed_by_name": null,
  "note": null,
  "contribution": ContributionOut | null,   // scope=node only
  "validation": {...} | null                // scope=node only
}
```

Every save of the canonical file (upload, `PUT /content`, a new version, the
`/v1` private append/replace, legacy import) writes its download-only
identifiers before storing it: the `contribution` table's `id`, and in every
other table that the data model gives the columns, `contribution_id` and a
`row_id` numbered 1..N across all the contribution's rows in file order.
Supplied values are overwritten, so a re-uploaded download is renumbered. A
file that does not parse is stored as sent. Both columns stay out of
`summary._all`. Files saved earlier are backfilled by `fiesta stamp-ids`
([storage-and-migration.md](storage-and-migration.md#existing-fiesta-data-and-legacy-migration)).

### Import templates (`/v2/{repository}/private/import-templates`, Bearer or Basic)

The upload page's saved import settings, per user and node (shared schema,
`import_templates`). `settings` is `{table_name, n_header_rows ("" for no header
row), column_map: {input header: data-model column | null}, exclude_column_names,
exclude_table}`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `` | | the caller's templates on this node, by name: `[{id, name, settings, created_at, updated_at}]` |
| POST | `` | `{name, settings}` | the template (201); 409 when the caller already has one of that name |
| PUT | `/{template_id}` | `{name?, settings?}` | the template (rename, save new settings, or both); 404 for another user's |
| DELETE | `/{template_id}` | | 204 |

### Workspaces (`/v2/{repository}/workspaces`, Bearer or Basic)

Shared workspaces: owners control membership, editors save, viewers read. In
data-source mode the list still answers and every write (POST, PUT, DELETE) is a
409 naming where to contribute, as under `private/contributions`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v2/{repository}/workspaces` | | workspaces the caller owns, is a member of, or (admin) all — with the caller's `role` |
| POST | `/v2/{repository}/workspaces` | `{name}` | `{id, name}` (201) |
| PUT | `/v2/{repository}/workspaces/{workspace_id}/members` | `{user_id, role: "viewer"\|"editor"}` | `{role}` (owner only) |
| DELETE | `/v2/{repository}/workspaces/{workspace_id}/members/{user_id}` | | 204 (owner only) |
| PUT | `/v2/{repository}/workspaces/{workspace_id}/contributions/{contribution_id}` | | `{workspace_id}` (assign an owned contribution) |

### Data-source sync (`/v2/{repository}/source`, node admin)

A node in data-source mode (`FIESTA_CONTRIBUTIONS_MODE`, `contributions_mode` in
its config) refuses every write under `private/contributions`, `private/requests`
and `workspaces` with a 409 and is
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
| GET | `/v2/{repository}/plugins/method-codes` | `method-codes` (MagIC) — `{<group>: {label, codes: [{code, definition, ...}]}}` (404 if the node has no codes file); was `/config/method-codes` until 2026-11-11 |
| GET | `/v2/{repository}/plugins/pmag-plots/contributions/{id}/{kind}` | `pmag-plots` (MagIC) — plot data, `kind` ∈ `demag`, `eqarea`, `arai`, `hyst`; counts are `summary.pmag_plots` of `GET /search/pmag_plots?contribution={id}` |
| GET | `/v2/{repository}/plugins/depth-plot/contributions/{id}/measurements` | `depth-plot` (CDR) — `{series_defs, tracks: [{key, label, unit, group, color, log, default}], ratios: [{key, label, numerator, denominator, log, color, default}], cores: {<core>: [{depth, section, _bad?, <column>: number, ...}]}, sections: {<core>: [{section, top, bottom}]}}`: every Number measurements column with data is a track; calibration sections and rows above `min_depth` are left out, rows whose quality is in `bad_quality` carry `_bad`; section spans come from the rows' depths (2026-11-16) |
| GET | `/v2/{repository}/plugins/plateau-calculations/contributions/{id}` | `plateau-calculations` (KArAr) — `{experiments: [{experiment, specimen, steps, ages, ...}], specimens: [{specimen, age, experiments, j_value, irrad_*, is_flux_monitor, ...}], samples: [{sample, elevation, height, core_depth, composite_depth, ...}]}` (steps also carry `k_ca`, `ar40_rad` in %, and `cl_k` = ³⁸Ar(Cl)/³⁹Ar(K)), every value as contributed; `?experiment=` or `?specimen=` narrows it (query params: names contain `/`); replaced `.../experiments/{name}/plateau` on 2026-11-12 |

## Search document shape

Search documents keep the legacy shape `{type, summary: {contribution, <level>,
_all}, rows}`. `summary._all` unions row values (capped 500/column) for
free-text search; the workflow flags `_is_activated` / `_is_latest` /
`_private_key` live in `summary.contribution`. Public reads are always
`_is_latest` and `_is_activated` unless a matching private key is supplied.
No search response returns `_private_key` (2026-11-13; it is still indexed, so
a `private_key:"…"` token matches): only the private workspace API gives a
contribution's key, to its owner or an admin.

A level's doc is one named record, as in the legacy index: a contribution's
rows of that level sharing a name (its key column, `site` for sites) are one
doc, `rows` holding them all, `summary.<level>` their merge (each column's first
value) plus `_n_results`, how many rows (the level's `count_field`). A row
without a name is a doc of its own. So a level's matches count records (the
Summaries tab), and their summed `_n_results` its rows (the Data tab).

Row values are text everywhere above (`summary.<level>`, `_all`), so every doc
also carries `summary._num` (2026-11-10): per data-model number column
(`Number`, `Integer`; not `contribution_id` / `row_id`) the sorted distinct
values of the record's rows as numbers, mapped as `double` — capped at 500 per
column but always keeping the least and the greatest; values that do not parse
are left out. The contribution doc's is the union across its levels (as its
`_all`). Columns a `search.unit_conversions` entry names are in its base unit:
MagIC's `age`, `age_low`, `age_high` are years BP by the row's `age_unit`
(factor, then offset: years AD → 1950 − year, which swaps low and high, also
when a row has only one of them: an `age_high` of 1600 years AD is the
`age_low` of 350 years BP; `age_sigma` only scaled, and never negative), and a
row whose unit has no factor leaves them out.
Range filters (`range=summary._num.age:0:5e6`) and histograms use these:

```json
"summary": {"sites": {"site": "HW01", "age": "2", "age_unit": "Ma", ...},
            "_num": {"age": [2000000.0], "dir_inc": [31.2, 33.0], ...}, ...}
```

A new or changed `_num` (or its `double` template) reaches an existing index
only through `fiesta rebuild`.

A unit conversion with an `interval` (MagIC, KArAr, ERDA, SC: `age`) also
gives every doc `summary._interval.<name>` (2026-11-13): each row's ages as
ONE interval in the base unit, whatever of value, sigma and bounds it has —
`age_low`..`age_high`; a missing end `age` ∓ `sigma_multiple` × `age_sigma`
(2, about 95%), else the age itself; a side with neither open (only an
`age_high`: younger than it). In years BP a sigma window stops at the present
(2026-11-16): a young age's window never reaches past 1950 (0.02 ± 0.015 Ma is
0 – 0.05 Ma, not −10 ka – 0.05 Ma), while an age already after 1950 (a negative
years BP: 2010 AD is −60) keeps its whole window, and stated bounds are kept
as stated. `interval.tables`, when set, are the only tables whose rows give
intervals: KArAr's are `specimens` and `experiments`, as a measurement's
`age` is one heating step's apparent age (often far off, even negative), not
an age of its specimen, sample or contribution. A record's are its own rows' plus those of rows
outside the hierarchy that name it as their most specific record (an `ages`
row naming a sample), else those of the records below it (a location without
ages has its sites'); the contribution's are every row's.

```json
"_interval": {"age": {
  "range": [{"gte": 480000.0, "lte": 520000.0}],   // double_range, merged, ≤ 100
  "values": [480000.0, 500000.0, 520000.0],        // ends + best estimates (histogram)
  "min": 500000.0, "max": 500000.0,                 // span shown: best estimates and
                                                    // stated bounds, not sigma windows
  "mid": 500000.0,                                  // median best estimate: sort, map color
  "n": 1, "open_low": false, "open_high": false,
  "detail": {"value": 500000.0, "sigma": 10000.0,  // one row only: its converted
             "contributed": "500 ± 10 ka"}}}       // columns and its text as given
```

Sigmas are not combined across rows: a record's rows (a location's sites)
are not replicate measurements of one age, so the roll-up is the union of
their intervals for matching and the span of their stated values for display,
never a weighted mean with a propagated σ (that is a science calculation, a
plugin's job, as the poles plugin's Fisher means are). Within a row σ is
converted by the unit's factor alone (no offset: 20 years AD is 20 years) and
counts only on the sides without a stated bound; KArAr's three 1σ columns are
tried external (J and decay constants), internal, analytical.

`range` is mapped `double_range`, so `range=summary._interval.age.range:5e6:2e7`
matches a doc any of whose intervals overlaps 5–20 Ma (OpenSearch's default
`intersects` relation; the legacy `_age_range_ybp` behaved the same on one
envelope per record); its histogram's extent is over `values`, its bins
count overlapping intervals (above). The time scale's shortcuts for a unit
that reaches the present (Holocene, Quaternary, Cenozoic, Phanerozoic) leave
the younger bound open (the Holocene is `range=summary._interval.age.range::11700`),
so ages after 1950 are in them; the search map's log Age color gives an age at or after 1950 (≤ 0) the
youngest color rather than "No value". The UI shows these with
`fiesta/frontend/src/lib/age.ts` (Ga / Ma / ka by magnitude, "yr BP" below 1 ka
with present = 1950 CE, one row in full as "500 ± 10 ka", several as their span).
`ensure_index` adds the template to an existing index; its docs gain the block
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
`POST .../import`, `PUT .../attachments/{name}`) require `Idempotency-Key` and the current
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
