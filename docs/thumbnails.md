# Files, embargoes and previews

> Design, 2026-09-27, revision 2. **Status: proposed, awaiting approval.**
> Nothing below is built, and no AWS resource exists. ROADMAP.md tracks it as
> Phase T.
>
> Revision 2 makes this a FIESTA service. OSU-MGR becomes a FIESTA node that
> keeps its own search interface, but reads FIESTA's OpenSearch index and API,
> and gets thumbnails from that API. The API is the one gate on what is public.
> Revision 1 had a standalone Lambda that decided visibility from S3 paths and
> published public thumbnails at unsigned URLs. That approach is dropped.

## What this adds to FIESTA

1. **File references.** Any node's rows can point at files: its own
   contribution attachments, or objects in a read-only **external source
   bucket** such as `osu-corelab-storage`. Node config declares which table and
   column hold them.
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
 FIESTA worker on MARFIK ── procrastinate job ── invoke ──► Lambda `fiesta-render` (us-west-2)
   (knows which files, records results in Postgres)            reads the source in-region, writes renditions
```

## Your two questions

### Should we use CloudFront at all?

**Yes, as the byte path behind the API's gate, not as a public CDN.**

| | CloudFront + signed URLs | Presigned S3 URLs | Everything on MARFIK |
|---|---|---|---|
| Egress price | S3 → CloudFront is free. Pay-as-you-go includes **1 TB a month and 10M requests free**, every month, per account; after that about $0.085/GB. The flat-rate **Pro plan is $15 a month for 50 TB**, with no overage. | $0.09/GB after 100 GB a month | Free per GB on the campus link (confirm with OSU) |
| Speed | Edge-cached worldwide; 479 MB TIFFs don't touch MARFIK | Straight from us-west-2 | Limited by MARFIK's uplink and one site |
| Gate | The API mints a URL only after its check. A leaked URL expires. | Same | Exact per request (nginx `X-Accel-Redirect` after the check) |
| Setup | A distribution, OAC on two buckets, a key group (operator) | None | Mirror 2+ TB, keep it synced, back it up |

Egress is roughly free either way, so cost doesn't decide it. CloudFront wins
because the bytes already live in S3. It makes serving them free and fast
without moving them, and MARFIK only answers small JSON requests.

### Should everything live on MARFIK, with S3 as a backup?

**No. S3 stays primary for file bytes. MARFIK keeps the compute and state it
already runs:** the API, the worker, Postgres and OpenSearch.

- **Curators upload to `osu-corelab-storage` today.** Making MARFIK primary means
  a new upload path for them, or an S3 → MARFIK sync that makes MARFIK a replica
  rather than the primary.
- **Mirroring costs about as much as rendering locally would.** The one-time
  copy is about 1.6 TB+ of S3 egress (about $135–150, about a day), and every
  new upload is pulled again. MARFIK also needs 2+ TB of growing disk, with its
  own backups. S3 already gives durability and versioning, at no cost to MARFIK.
- **MARFIK is one site.** Its outages and uplink would become the repository's
  download ceiling.
- **Renditions don't need a backup.** They are derived, can be regenerated and
  total about 15 GB, so they live in FIESTA's bucket next to the attachments.
- **When MARFIK-primary would win:** if EarthRef means to leave AWS, or if
  campus egress is free and AWS credits end. Neither has been stated; this is
  open decision 1.

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
    collection: { bucket: osu-corelab-storage, region: us-west-2 }

files:
  - table: files
    path: file                      # column holding the object key
    source: collection              # omit to mean this contribution's attachments
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
- **Source credentials and region live in deployment settings.** Access keys
  are deployment secrets (`FIESTA_S3_*`), never YAML. That IAM user gets
  read-only `s3:GetObject` on each source's prefix.
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
- **Where the renderer runs:** deployment setting `FIESTA_RENDERER=local|lambda`.
  - `local` renders in the worker process. Development (RustFS) and CI use it,
    and so would any deployment whose worker runs in AWS.
  - `lambda` makes a synchronous `lambda:Invoke` to `fiesta-render` in
    us-west-2. The request carries `{bucket, key, etag, out_bucket, out_key,
    profile}` and the reply carries sizes and status. The Lambda reads the
    source in-region and writes to FIESTA's bucket, so the only bytes crossing
    to MARFIK are small JSON messages.
  - The Lambda is a stateless function: no visibility rules, no config, no
    queues, no event wiring. FIESTA orchestrates it, retries it through
    procrastinate, and records the result.
- **Why a Lambda when the worker is on-premises.** The worker would otherwise
  pull 1.6 TB out of AWS for the backfill: about $135 and a day of transfer,
  repeated at every profile change. The Lambda does the same work for about $7
  in about an hour, at 50 concurrent. Steady-state uploads are small, so
  `local` would do for them. One code path for both is simpler.
- **Why not events and sweeps any more.** OSU-MGR files reach FIESTA through the
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
| Lambda compute, arm64 at 3 GB: core images about 5 s each, other images about 1.5 s, PDFs about 1 s | about $5.3 |
| S3 GET, PUT and HEAD, plus Lambda requests and logs | about $1.5 |
| Transfer | $0 (the source is read in-region; about 15 GB of renditions cross-region at most, if FIESTA's bucket is not in us-west-2) |
| Time at 50 concurrent jobs | about 45 min of render time (135k compute-seconds ÷ 50), about an hour with invoke overhead |
| Stored renditions | about 15 GB, about $0.35 a month |

The pilot comes first: `FIESTA_RENDERER=local` on one cruise from this machine,
with read-only credentials and output to the scratchpad. It reports sizes,
timings and examples, and costs under $0.50 of egress. Nothing is written to a
bucket.

## Build order

1. **Renderer and renditions:** `fiesta.renditions` (render, job, table,
   `local` runner, CLI) with tests, plus the one-cruise pilot. It can start now.
2. **Embargo and the file gate:** `can_read_file`; the `files:` config;
   `storage.sources`; signed URL minting; the redirect routes; URL fields in
   search and record responses; the existing download routes moved to
   redirects.
3. **The `lambda` runner:** a small zip holding only `render` and the Lambda
   handler (arm64; under 250 MB; no ECR), plus OPERATOR_TODO entries.
4. **OSU-MGR importer:** pipeline index or metadata into FIESTA contributions,
   one per cruise, with the moratorium turned into columns. It is a known gap
   in `docs/osu-mgr-node.md`, and a prerequisite for OSU-MGR's site to get
   anything from FIESTA.
5. **The OSU-MGR site** reads from FIESTA's `/v2/osu-mgr` (notes below).
6. **Backfill**, then steady state through the outbox.

Out of scope for v1:
- spreadsheet and CSV renditions (about 1.8k files; they need LibreOffice in a
  Lambda container image);
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
- the Lambda `fiesta-render` (arm64, 3,008 MB, 2 GB of `/tmp`, 5 min) and its
  role: read the sources, write `*/renditions/*`;
- `lambda:InvokeFunction` for FIESTA's IAM user;
- read-only access for FIESTA's IAM user to `osu-corelab-storage/Collection/*`.

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

1. **S3 primary with CloudFront (recommended), or MARFIK primary with S3 as a
   backup.** This hinges on whether EarthRef plans to leave AWS, and whether
   OSU's campus egress is really free at scale.
2. **Which AWS account** holds the Lambda and the distribution. Also, which
   region FIESTA's production bucket is in; us-west-2 would make the rendition
   writes free.
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
