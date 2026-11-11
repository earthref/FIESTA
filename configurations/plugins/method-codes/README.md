# `method-codes` (MagIC)

A node's method-code vocabulary, moved out of core on 2026-11-11 (it was
`vocabularies.method_codes` and `GET /config/method-codes`). The codes are
`<slug>/<file>` in the node's configuration folder (`magic/method_codes.json`),
a `{group: {label, codes: [{code, definition, ...}]}}` map converted from the
legacy MagIC repo.

- **Page**: `/method-codes`, every group with its codes, filtered by `?q=`
  across group names, codes and definitions.
- **Home**: a Method Codes card in the default resource row (only when the
  node YAML sets no `features.home.resources`; magic.yaml lists its own card).
- **Facets**: the filter modals show each code's definition beside a facet
  value that is a code, grouped and ordered as in the file.
- **Validation**: a `cv("<vocabulary>")` validation takes every code, compared
  case-insensitively, when the node's controlled vocabularies have no list of
  that name. (No data model says `cv("method_codes")` today; MagIC's columns
  say `type("method_codes")`, which is not enforced.)

`GET /v2/{node}/plugins/method-codes` returns the file (404 without one).

Options (magic.yaml `plugins.method-codes`): `file` (default
`method_codes.json`) and `vocabulary` (default `method_codes`). A missing file
means no codes (no page data, no card, no vocabulary); a malformed one fails
validation.

| File | What |
|---|---|
| `plugin.py` | `MethodCodesPlugin`: options, the file check, the vocabulary, the route |
| `index.tsx` | the UI module: the page, the resource card, the facet definitions |
| `method-codes-page.tsx` | the Method Codes page |
| `method-codes-data.ts` | the codes' types and shared query |
| `test_method_codes.py` | the file, the route, case-insensitive `cv()` validation |

The grid's Method Codes tile is the `sample-tiles` plugin's (it lists a
record's `method_codes` values whether or not the node has a vocabulary).

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
