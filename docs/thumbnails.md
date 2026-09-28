# Files, embargoes and previews

> Design, 2026-09-27, revision 3. **Status: proposed, awaiting approval.**
> Nothing below is built, and no AWS resource exists. ROADMAP.md tracks it as
> Phase T.
>
> Revision 2 made this a FIESTA service. OSU-MGR becomes a FIESTA node that
> keeps its own search interface, but reads FIESTA's OpenSearch index and API,
> and gets thumbnails from that API. The API is the one gate on what is public.
> Revision 1 had a standalone Lambda that decided visibility from S3 paths and
> published public thumbnails at unsigned URLs. That approach is dropped.
>
> Revision 3: the OSU-MGR collection's **primary copy is on HAVISIDE**, a
> Windows server in the same rack as MARFIK; `osu-corelab-storage` is its
> backup. The worker renders from HAVISIDE over the rack network, so the
> Lambda is gone and the backfill costs nothing in AWS transfer.

## What this adds to FIESTA

1. **File references.** Any node's rows can point at files: its own
   contribution attachments, or objects in a read-only **external source
   bucket** such as `osu-corelab-storage`. Node config declares which table and
   column hold them.
   **External files are referenced in place, never copied.** An OSU-MGR
   contribution holds only the metadata row: `(source, key)`, type, size and
   embargo. The raw files already exist twice: the primary on HAVISIDE and the
   backup in `osu-corelab-storage`. FIESTA adds no third copy. They are not
   uploaded as supplemental files, and FIESTA neither replicates nor versions
   them.
   - A row names the S3 key, because that is what downloads serve. The
     renderer reads the same file from HAVISIDE's primary copy, which it finds
     through the source's `mirror` (see "Where the renderer reads from").
   - The only new bytes FIESTA stores are the renditions: about 15 GB, roughly
     1% of the 1.6 TB of sources.
   - A source file that disappears or changes just yields a new ETag or a 404.
     FIESTA's revision history covers the metadata rows, not the external
     bytes.
2. **Embargo.** A row-level "withheld until" state, which is a core concept and
   not OSU-MGR's moratorium special case. It sits beside the existing
   contribution visibility (`is_activated`, `private_key`, owner, admin).
3. **One file gate**, in `fiesta.services.access`. Every route that hands out
   bytes asks it: originals, previews, thumbnails, bulk downloads.
4. **Renditions.** A thumbnail that fits a 400 px box and a preview that fits a
   2048 px box, for image files and PDF page 1. They are rendered for every
   renderable file, public or not, and stored privately. Postgres records which
   exist.
5. **Delivery.** The API returns short-lived **CloudFront signed URLs** only for
   files the caller may see. Bytes flow from S3 through CloudFront and never
   through MARFIK.

```
 osu-mgr-website (own UI) ─┐
 FIESTA SPA ───────────────┼─► FIESTA API on MARFIK ── gate: contribution visible? row embargoed? hidden type?
 api.earthref.org callers ─┘     │  search/record responses carry signed URLs for allowed files only
                                 ▼
                    browser ──► CloudFront (signed URLs only, OAC) ──► S3: FIESTA bucket (renditions, attachments)
                                                                   └► S3: osu-corelab-storage (originals, read-only)
 FIESTA worker on MARFIK ── renditions job ── reads over the rack LAN (SMB, read-only) ──► HAVISIDE (primary copy)
   (knows which files, records results in Postgres)  └─ writes about 15 GB of renditions ──► S3: FIESTA bucket
 HAVISIDE ── existing backup job ──► S3: osu-corelab-storage
```

## Your two questions

### Should we use CloudFront at all?

**Yes, as the byte path behind the API's gate, not as a public CDN.**

| | CloudFront + signed URLs | Presigned S3 URLs | From HAVISIDE through MARFIK |
|---|---|---|---|
| Egress price | S3 → CloudFront is free. Pay-as-you-go includes **1 TB a month and 10M requests free**, every month, per account; after that about $0.085/GB. The flat-rate **Pro plan is $15 a month for 50 TB**, with no overage. | $0.09/GB after 100 GB a month | Free per GB on the campus link (confirm with OSU) |
| Speed | Edge-cached worldwide; 479 MB TIFFs don't touch MARFIK | Straight from us-west-2 | Limited by the rack uplink and one site; public load on a Windows file server |
| Gate | The API mints a URL only after its check. A leaked URL expires. | Same | Exact per request (nginx `X-Accel-Redirect` after the check) |
| Setup | A distribution, OAC on two buckets, a key group (operator) | None | A read-only share and nginx; no mirror needed (HAVISIDE is the primary) |

Egress is roughly free either way, so cost doesn't decide it. CloudFront wins
because a complete copy already lives in S3 (the backup). It makes serving them free and fast
without moving them, and MARFIK only answers small JSON requests.

### Should everything live on MARFIK, with S3 as a backup?

**That is already the shape of the collection:** the primary copy is on
HAVISIDE, in MARFIK's rack, and S3 is the backup. The design uses each copy for
what it is good at:

- **Rendering reads HAVISIDE.** It is rack-local and free, and it needs no
  mirror and no extra disk. Only the renditions (about 15 GB) go up to S3.
- **Downloads and renditions are served from S3 through CloudFront.** The
  backup already exists, serving from it is free up to 1 TB a month, and edge
  caching keeps 479 MB downloads off the rack's uplink and off a Windows file
  server. Serving from HAVISIDE through MARFIK (nginx `X-Accel-Redirect`) is the
  alternative. Campus egress is free too, but the rack's uplink becomes the
  ceiling, and HAVISIDE would be exposed, even if only indirectly, to public
  load. That is open decision 1.
- **Renditions don't need a backup.** They are derived, and they can be
  regenerated from HAVISIDE for free. They live in FIESTA's bucket.
- **The backup must hold every public file**, because that is what downloads
  serve. A file that is on HAVISIDE but not yet backed up gets its rendition
  (it is rendered from HAVISIDE), but a download returns a 404 until the backup
  catches up. Rows reference S3 keys and ETags, so the importer only lists what
  the backup holds.

## Embargo, a core concept

**The gate.** A file is publicly available only when all of these hold:

1. its contribution is visible to the caller, under today's rule: activated,
   or the owner, a workspace member, a node admin, or a matching `private_key`;
2. its row is not embargoed: the embargo flag is unset, or `embargo_until` has
   passed. `embargo_until` is evaluated at request time, so a dated embargo
   lifts itself;
3. its type is not listed in the node's `hidden_types`, which are never public.

Node admins, the contributor and the workspace's editors bypass conditions 2
and 3. They are the curators, who need to see withheld material.

- **What the check covers.** `can_read_file(session, node, user, contribution,
  row, private_key)` in `fiesta.services.access` implements it. Search
  responses, record responses, the file, rendition and bulk-download routes,
  and plugin routes (through `load_visible_parsed`) all call it. A new
  file-serving route may not bypass it.
- **Search documents keep embargoed rows' metadata.** OSU-MGR shows them with a
  lock and a "Moratorium" badge today. The API adds no URLs to such rows, and a
  node can hide the rows entirely instead (`embargo.hide_rows`).
- **OSU-MGR's moratorium becomes data.** The OSU-MGR importer turns the
  `-moratorium` folder suffix and the rows of `Collection/moratorium.xlsx` into
  each `files` row's `moratorium` and `moratorium_expiration` columns (both
  already in the data model). FIESTA core never knows about folder suffixes or
  spreadsheets.
  - **Lifting** is a re-import: the rename, or the spreadsheet change, reaches
    FIESTA as a new revision with the flag cleared.
  - **Imposing** works the same way. From that revision on, the API stops
    minting URLs; URLs already handed out expire within their lifetime (below).
- `/v1`, the frozen legacy contract, serves only MagIC contribution files, so
  nothing there changes.

## Per-node config

```yaml
# config/osu-mgr.yaml
storage:
  bucket: osu-mgr
  sources:                          # read-only external buckets that rows may reference
    collection:
      bucket: osu-corelab-storage   # the backup: what rows reference and downloads serve
      region: us-west-2
      mirror:                       # the primary copy, which the renderer reads
        path: /mnt/haviside/collection   # read-only SMB mount on the worker host
        key_prefix: "Collection/"        # S3 key = key_prefix + path relative to the mount
      s3_fallback_bytes_per_day: 5368709120   # 5 GB a day (about $0.45) when the mirror copy is missing or differs

files:
  - table: files
    path: file                      # column holding the object key
    source: collection              # referenced in place; omit only for files uploaded into FIESTA as attachments
    type: file_type                 # column holding the type (a cv("file_type") term)
    size: size_bytes
    embargo: { flag: moratorium, until: moratorium_expiration, hide_rows: false }
    hidden_types: [igsn-sheet, imlgs-file, itrax-xray-image]
    renditions:
      image: [core-image, itrax-image, ct-image, ct-gray-image, ct-color-image, xray-image,
              field-image, whole-rock-image, whole-rock-foi-image,
              thin-section-plane-polarized-image, thin-section-plane-polarized-foi-image,
              thin-section-cross-polarized-image, thin-section-cross-polarized-foi-image]
      pdf:   [core-description, coring-data-sheet, cruise-report, dredge-log]

# config/erda.yaml (once ERDA stores object bytes)
files:
  - { table: files, path: file, type: media_type, renditions: { image: [image/jpeg, image/png, image/tiff], pdf: [application/pdf] } }
```

- **Validation**, at load time and before every publication:
  - `table` and each column exist in the data model;
  - `source` is declared under `storage.sources`;
  - every type named is a term of the column's controlled vocabulary. That check
    would catch today's drift, where the pipeline renders `igsn-sheet` but the
    site hides it.
- **The type comes from a column, not from path patterns.** The importer that
  fills the `files` rows already classifies by `FILE_TYPES`, so FIESTA needs no
  copy of those regexes.
- **Source credentials live in deployment settings.** Access keys are
  deployment secrets (`FIESTA_S3_*`), never YAML. That IAM user gets read-only
  `s3:GetObject` on each source's prefix. The mirror's mount path is not a
  secret, so it goes in the YAML with the rest of the deployment. A host
  without the mount (a laptop, CI) uses the S3 fallback within its budget.
  Development seeds use RustFS and never reach the budget.
- Sizes, format and quality belong to the render **profile** (`r1`), not to
  nodes.

**Core, not a plugin.** Visibility must be decided in one place, and file
delivery is storage, not node science. It also serves several plugins
(`record-cards`, `digital-objects`) as well as the core file lists. Plugins read
the URLs the core attaches.

## Renditions

- **Key**, in the node's storage prefix:
  `renditions/{profile}/{source}/{key}/{etag}/{thumb|preview}.webp`. Attachments
  use the source `attachments` and their `sha256` in place of the ETag. The key
  is content-versioned, so objects are immutable
  (`Cache-Control: public, max-age=31536000, immutable`). A changed file gets a
  new key, and nothing is ever invalidated.
- **State in Postgres**, following the hard rule that Postgres owns application
  state. A per-node table `renditions`, with `(source, key, etag, profile)`
  unique, records:
  - `status`: `ok`, `skipped` or `error`;
  - width, height and bytes for each size;
  - `error` and `rendered_at`.
  The API therefore knows what exists without listing S3, and a rebuild never
  needs S3 to find it. The migration follows the `schema_translate_map` rule:
  `create_table` only.
- **When they are made.** After a revision is committed, the outbox enqueues
  `render_files(node, contribution_id)` on the node's queue. It diffs the
  contribution's file rows against `renditions`, and for each missing
  `(key, etag)` it calls the renderer. On completion it enqueues a re-index, so
  search documents record which files have a rendition. Backfill is
  `fiesta renditions backfill --node osu-mgr`, which enqueues the same job for
  every contribution; worker concurrency caps the load.
- **The renderer runs in the FIESTA worker**, on its own `renditions` queue,
  served by a separate worker process with a small concurrency
  (`fiesta worker --queues renditions --concurrency 4`). A 55k-file backfill
  therefore never delays contribution processing.
- **Where the renderer reads from.** For each `(key, etag)` the job:
  1. maps the key to the mirror path (`key_prefix` stripped, `/` kept; the SMB
     mount handles case-insensitive Windows names);
  2. copies the file to local `/tmp` while hashing it, so it crosses the rack
     network once, then renders from `/tmp`;
  3. **checks the copy is the backup's object.** The sizes must match. When the
     ETag is a plain MD5 (a single-part upload), the hash must match too. A
     multipart ETag is checked on size alone. This keeps previews and downloads
     showing the same bytes;
  4. **on a missing or different mirror file** (the backup is newer, or the
     primary was renamed or deleted), reads from S3 instead within
     `s3_fallback_bytes_per_day`. Past that budget, the job records status
     `waiting`, and the next revision or a `fiesta renditions retry` picks it
     up.
- **No Lambda and no AWS compute.** The bulk bytes never leave the rack. Only
  renditions go up to S3, which is free ingress. The same code runs everywhere:
  development and CI read from RustFS, production reads HAVISIDE. A Lambda
  runner stays a documented fallback, in case HAVISIDE is ever out of reach, but
  it is not built.
- **Why not S3 events and sweeps.** OSU-MGR files reach FIESTA through the
  importer, so FIESTA's outbox is the trigger. There are no S3 notifications,
  EventBridge rules, SQS queues or scheduled sweeps to run.

### Rendering (`fiesta.renditions.render`, pure: bytes in, WebP out)

| Input | Decoder |
|---|---|
| TIFF: strips, multi-frame CT, 16-bit | pyvips `thumbnail("f.tif[page=N]", 2048, height=2048, size=down)`. It streams with block shrink, so a 479 MB TIFF never sits in memory. A multi-frame file uses page `n_pages // 2`. |
| JPEG, PNG | pyvips `thumbnail`, with libjpeg shrink-on-load, EXIF rotation, and conversion to sRGB. |
| BMP, or anything pyvips can't open | Pillow `reduce` then LANCZOS, bounded by `max_pixels` (set per call, never globally off). |
| PDF | Page 1 at zoom `min(2048/w, 2048/h)`, with pypdfium2 (Apache/BSD licence; PyMuPDF is AGPL, see open decision 5). |
| CR2, RAW, over `max_source_bytes` | status `skipped` |

Beyond the decoders:
- **Thumbnail from preview.** Each file is decoded once, at preview size; the
  thumbnail is resized from the preview.
- **16- and 32-bit to 8-bit.** A linear stretch between the 0.5th and 99.5th
  percentiles, computed on the shrunk image.
- **Alpha** is flattened onto white.
- **Output.** Both sizes fit their box and never upscale. WebP, at quality 75
  for the thumbnail and 80 for the preview, with metadata stripped.

**Tests**, with fixtures generated in `conftest.py`:
- a multi-frame 16-bit TIFF;
- a 20:1 strip;
- a BMP;
- a 3-page PDF;
- a 400-megapixel compressed TIFF, which must render within budget and be
  refused when it exceeds `max_pixels`.

Also tests for `can_read_file` (every row of the gate) and for the job's diff
and retry.

## Delivery: the API hands out signed URLs

- **Search and record responses.** For every file row the caller passes the
  gate on, the API adds:
  - `thumbnail_url` and `preview_url`, when a rendition is `ok`;
  - `download_url`, always.
  Rows that fail the gate get none, so the UI shows an icon or a lock and never
  probes for a 404.
- **Signed URLs.** They use a CloudFront canned policy, signed with a key-group
  private key that only the API holds (`FIESTA_CDN_KEY_ID`,
  `FIESTA_CDN_PRIVATE_KEY`, `FIESTA_CDN_URL`).
  - **Public files:** expiry is rounded to the next UTC midnight plus 24 h. The
    URL stays the same all day, so browsers cache it. CloudFront's cache key
    ignores the signature, so the edge caches across days.
  - **Private or embargoed files, for curators:** 15-minute expiry.
  - **Downloads:** 1 h, with `response-content-disposition` for the original
    filename.
- **Stable links** for callers that can't hold a URL:
  `GET /v2/{node}/files/{row_id}/{thumbnail|preview|download}` runs the gate and
  returns a 302 to a freshly signed URL.
- **Withdrawal.** When a file becomes embargoed or a contribution is
  deactivated, new responses stop carrying its URLs immediately. A URL already
  handed out works until it expires: at most 48 h for a public file, 15 minutes
  for a curator's. If that window is too long, shorten the public expiry; that
  trades away browser caching, not correctness.
- **The existing `download_contribution` and `attachment_download` routes** read
  the whole file into API memory. They move to the same signed redirect.

## Backfill cost and time (OSU-MGR, about 55,400 files)

| Item | Estimate |
|---|---|
| AWS transfer | $0: 1.6 TB is read from HAVISIDE over the rack LAN, and 15 GB goes up to S3 (ingress is free) |
| S3 requests | about $0.60 (111k PUTs, 55k HEADs for ETags) |
| Rack network | 1.6 TB: about 4 h at 1 GbE, or about 1 h at 10 GbE (disk-bound) |
| Worker CPU | about 100k CPU-seconds (core TIFFs about 3 s each, other images about 1 s, PDFs about 0.5 s): about 7 h at concurrency 4, or 3.5 h at 8 |
| Wall time | **overnight**, since CPU and network overlap; the pilot measures the real figure on fiesta-ct |
| Stored renditions | about 15 GB, about $0.35 a month |

The pilot comes first, on one cruise:
- on fiesta-ct against the HAVISIDE mount once it exists;
- before that, from this machine against S3, read-only, with output to the
  scratchpad. That costs under $0.50 of egress.

It reports sizes, timings and examples. Nothing is written to a bucket. The
pilot also sets the worker concurrency and the memory ceiling: a BMP decoded
through Pillow can take about 1 GB.

## Build order

1. **Renderer and renditions:** `fiesta.renditions` (render, job, table, the
   `renditions` queue, CLI) with tests, plus the one-cruise pilot. It can start
   now.
2. **Embargo and the file gate:** `can_read_file`; the `files:` config;
   `storage.sources`; signed URL minting; the redirect routes; URL fields in
   search and record responses; the existing download routes moved to
   redirects.
3. **Mirror reads:** the mount mapping, copy-and-hash, the check against the
   ETag, the S3 fallback budget, status `waiting` and `fiesta renditions retry`;
   plus OPERATOR_TODO entries.
4. **OSU-MGR importer:** pipeline index or metadata into FIESTA contributions,
   one per cruise, with the moratorium turned into columns. It is a known gap
   in `docs/osu-mgr-node.md`, and a prerequisite for OSU-MGR's site to get
   anything from FIESTA.
5. **The OSU-MGR site** reads from FIESTA's `/v2/osu-mgr` (notes below).
6. **Backfill**, then steady state through the outbox.

Out of scope for v1:
- spreadsheet and CSV renditions (about 1.8k files; they need headless
  LibreOffice on the worker host);
- deep zoom for core strips.

**Operator work** (goes into OPERATOR_TODO once approved):
- a CloudFront distribution with two S3 origins:
  - FIESTA's bucket, through OAC, for `*/renditions/*` and the attachment
    blobs;
  - `osu-corelab-storage`, through OAC, for `Collection/*`.
  Both require signed URLs from one trusted key group. Cache policy
  `CachingOptimized` (query strings are not in the cache key), HTTPS only, a
  `files.earthref.org` alias with its ACM certificate in us-east-1, and CORS
  `SimpleCORS`;
- the key group's private key, stored in FIESTA's production env;
- read-only access for FIESTA's IAM user to `osu-corelab-storage/Collection/*`
  (HEAD for ETags, and the fallback), and write access to its own
  `*/renditions/*`;
- **a HAVISIDE read-only share of the collection**, for a dedicated read-only
  Windows account. Mount it with SMB 3 on the fiesta-ct host (`cifs`, `ro`,
  credentials file mode 600). If fiesta-ct is an unprivileged container, mount
  it on the hypervisor and bind-mount it into the container read-only, at the
  YAML's `mirror.path`;
- a second worker process for the `renditions` queue in `deploy-fiesta.sh`,
  with the concurrency the pilot recommends.

## Notes for the OSU-MGR repos (not edited from FIESTA)

**osu-mgr-pipeline**
- It becomes the importer's source, or the importer itself. It writes
  cruise-level FIESTA contributions: files rows with `file_type`, `size_bytes`,
  `moratorium` and `moratorium_expiration`. It resolves the folder suffix and
  `moratorium.xlsx` there, as `_is_moratorium()` does today. Decide whether the
  spreadsheet's end date becomes `moratorium_expiration`, which would lift the
  embargo automatically; today nothing reads those dates.
- Retire `generate_thumbnails()` and `Collection/Thumbnails/`, which is empty.
  Rotate the hard-coded OpenSearch credential (flagged in
  `docs/osu-mgr-node.md`).

**osu-mgr-website**
- Search and records come from `/v2/osu-mgr/...` instead of its own OpenSearch
  alias. File entries arrive with `thumbnail_url`, `preview_url` and
  `download_url`, or without them when withheld.
- **`FileCard`**: use `thumbnail_url` when present, otherwise the current icon,
  or the lock for a withheld file.
  - Switch `object-cover` to `object-contain`, so a 20:1 strip is not cropped
    to a sliver.
  - Add `loading="lazy"`.
  - Add an `onError` fallback to the icon.
- **`FileRow`**: use `preview_url`, instead of loading the full original at
  natural size. TIFFs and PDFs get a picture for the first time.
- **Retire `pages/api/file/[...path].ts`.** Today it streams any key in the
  bucket without authentication, moratorium files included. Downloads use
  `download_url`.
- `hiddenFileTypes` and `moratoriumCruises` go away: the API only returns what
  the gate allows.

## Open decisions

1. **Where downloads are served from:** the S3 backup through CloudFront
   (recommended), or HAVISIDE through MARFIK's nginx. The latter makes campus
   egress free, but the rack uplink becomes the ceiling and the Windows file
   server sits behind public traffic. Renditions go through CloudFront either
   way.
2. **Which AWS account** holds the distribution. Also, which region FIESTA's
   production bucket is in. Cross-region is only the 15 GB of renditions, so
   it hardly matters.
3. **Serving originals through CloudFront.** Recommended, because egress is
   free. It needs an OAC grant in `osu-corelab-storage`'s bucket policy, which
   is safe because every request must carry an API-minted signature. The
   alternative is presigned S3 URLs: $0.09/GB, with no change to that bucket.
4. **How long public URLs live:** until midnight plus 24 h (recommended), or
   shorter, for faster withdrawal at the cost of browser caching.
5. **pypdfium2 (recommended) or PyMuPDF**, which is AGPL while FIESTA is MIT.
6. **Core strips on cards.** Plain fit with `object-contain` (recommended), or a
   fold-into-segments profile; and whether strip previews get a 4096 long side.
   Decide from the pilot's examples.
7. **Metadata of embargoed rows** visible with a lock (recommended, as OSU-MGR
   does today), or hidden (`hide_rows`).
8. **Moratorium end dates**: automatic lifting through `moratorium_expiration`,
   or manual only, as today.
9. **The HAVISIDE → S3 backup.** Which tool runs it and how often. Does it
   propagate deletes and renames (moratorium renames)? Does it upload
   multipart, and at what part size? The answers set how often the S3 fallback
   fires and how strong the check against the ETag can be.
10. **The HAVISIDE share layout**: is the S3 key `Collection/...` the share path
    with `\` turned into `/`? `moratorium.xlsx` stores Windows-style prefixes,
    which suggests it is.
