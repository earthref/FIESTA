# Thumbnails and previews

> Design, 2026-09-27. **Status: proposed, awaiting approval.** Nothing below is
> built, and no AWS resource exists yet. ROADMAP.md tracks it as Phase T.

One shared service renders two small images for every image file and document a
node's records point to:

- a **thumbnail**, which fits a 400 × 400 box, for result cards and file lists;
- a **preview**, which fits a 2048 × 2048 box, for the modal and the file page.

They are stored in S3 and served through CloudFront at deterministic,
content-versioned URLs. The first consumer is OSU-MGR's own website and
pipeline, which are not on FIESTA yet. The design therefore works for a caller
outside FIESTA as well as for FIESTA's own nodes.

## Decisions at a glance

| Question | Proposal |
|---|---|
| Where rendering runs | A Lambda in **us-west-2**, next to the data. FIESTA's worker is on-premises at OSU, not in AWS (below). |
| One renderer | The Python package `earthref-thumbnails` (`thumbnails/` in this repo). The Lambda, a local CLI and later the FIESTA worker all call the same `reconcile()`. |
| Core or plugin | **Core**, as an optional `thumbnails:` section in `NodeConfig` beside `storage:`. The reasons are below. |
| Where images live | A dedicated bucket `earthref-thumbnails` (us-west-2) under the `t/` prefix. Source buckets are never written to and never exposed. |
| URL | `https://thumbs.earthref.org/t/r1/{bucket}/{key}/{etag}/{thumb\|preview}.webp`, computable from (bucket, key, ETag) alone. |
| Format | WebP. The thumbnail is quality 75 and the preview quality 80, with metadata stripped. |
| Caching | `Cache-Control: public, max-age=31536000, immutable`. A changed source file gets a new URL; edge copies live at most 1 day (CloudFront max TTL). |
| Knowing what exists | One S3 LIST of `t/r1/{bucket}/{prefix}` returns every `thumb.webp`. That is about 110 LIST requests for all of OSU-MGR, so callers never probe for 404s. |
| Backfill | The daily sweep's first run over the existing S3 inventory. Estimate: about $7 and under 30 minutes, against about $135 and about a day to pull the data on-premises. |

## Where generation runs, and why

**FIESTA runs outside AWS.** `deploy.yml` notes that the `fiesta-ct` runner is
self-hosted on the deploy host. FIESTA serves `dev.earthref.org/<Node>/`, and
`dev.earthref.org` resolves to 128.193.72.23, which is Oregon State University's
campus network. The `fiesta-ct` runner's own address is not visible from here, so
confirm that the worker runs on that same host (open decision 1). For contrast,
`api.earthref.org` resolves to AWS us-west-2 addresses; that is the legacy API.

Rendering from the worker would pull every source byte out of AWS:

| | On-premises worker | Lambda in us-west-2 |
|---|---|---|
| Bytes read | about 1.6 TB (1.5 TB of core images, plus about 70 GB of whole-rock images, about 15 GB of thin sections and about 15 GB of PDFs) | the same bytes, read in-region |
| S3 data transfer | about $135 (first 100 GB free, then $0.09/GB) | $0 |
| Wall time | about 18 h of download at 200 Mbps, or about 3.6 h at 1 Gbps, plus decoding on one host | about 25 min at 100 concurrent invocations |
| Compute | on-premises CPU | about $5 (below) |

An AWS data-egress waiver for research institutions might remove the $135. It
would not remove the day of transfer. So **generation runs in a Lambda in
us-west-2**:

```
 osu-corelab-storage ──S3 events──► EventBridge rule ─┐
 (ObjectCreated / ObjectRemoved under Collection/)    │
                                                      ▼
 daily EventBridge Scheduler ─► sweep ─(1 msg/key)─► SQS thumbs-work ─► Lambda reconcile(bucket, key)
 local CLI `ensure` / pilot ──────────────────────────┘      │            │
                                                           DLQ            ├─► GET source (in-region)
                                                                          ├─► PUT t/r1/... in earthref-thumbnails
                                                                          └─► CloudFront invalidation on withdrawal
 earthref-thumbnails ◄──OAC (t/* only)── CloudFront (thumbs.earthref.org) ◄── browsers
```

- **Every trigger calls the same function**, `reconcile(bucket, key)`. It is
  idempotent: it brings the thumbnails for that one key in line with the key's
  current state. Duplicate or out-of-order events are therefore harmless. For
  example, a late `ObjectRemoved` for a key that has since been re-uploaded
  finds the new object and keeps its thumbnails.
- **S3 events reach the Lambda through EventBridge**, not a bucket notification.
  EventBridge cannot collide with notification configurations the bucket already
  has, it filters on the `Collection/` prefix, and it works across accounts if
  the bucket and the Lambda end up in different ones.
- **SQS sits in front of the Lambda.** It is the single buffer, and the event
  source's maximum concurrency caps load. A cruise-folder rename (thousands of
  copies at once) drains steadily instead of throttling, and failures land in a
  dead-letter queue.
- **The daily sweep is also the backfill.** It reads the latest S3 inventory
  (the bucket already has three daily inventories in
  `osu-corelab-storage-inventory`, which the pipeline reads) and lists the
  thumbnail prefix. It then enqueues every public key that has no thumbnail,
  and every thumbnail whose source is gone or no longer public. This catches
  missed events and moratorium list changes. Its first run renders the whole
  collection. S3 Batch Operations over the inventory would also work, but it
  adds a job role and a report bucket and gives nothing the sweep does not.
- **The local CLI** (`earthref-thumbnails render|reconcile|ensure|sweep --dry-run`)
  runs the same code from any machine. It is used for the pilot on one cruise
  and for repairs. `ensure` only enqueues work, so no data leaves the region.

**FIESTA's own contribution files** are handled differently: the worker renders
them with the same package, as a procrastinate job (phase 2 below). The dividing
rule is **whoever can decide visibility renders**. An OSU-MGR file's visibility
follows from its S3 path, so a Lambda can decide it. A FIESTA contribution's
visibility is `is_activated` in Postgres, and only FIESTA can read that. Those
files are few and small, so pulling them on-premises costs nothing that matters.

## Core or plugin: core

This is a core `thumbnails:` section in `NodeConfig`, next to `storage:`, and
not a plugin, for four reasons:

1. **It is not node science.** Poles and plateaus are plugins because they are
   one repository's domain logic. A thumbnail is a derived storage artefact that
   any node with image or document files needs, like a search document.
2. **Visibility must be decided in one place** (a hard rule in `CLAUDE.md`). The
   "is this file public" decision for thumbnails lives in one module of the
   package, and every runner calls it. A plugin would put it behind a hook that
   only the API process loads.
3. **It runs outside the API.** None of the plugin hooks fit a Lambda:
   `derive_docs`, `build_router` and `frontend_config`. The Lambda must not
   import FastAPI, SQLAlchemy or the plugin registry.
4. **Several consumers read it**: `record-cards`, `digital-objects`, the core
   file lists, and OSU-MGR's website. They read URLs, and they need no plugin of
   their own.

The section's pydantic model lives in the package (`earthref_thumbnails.policy`),
and `NodeConfig` imports it. FIESTA's loader and the Lambda therefore validate
the same schema. The section is optional: without it, a node has no thumbnails.

## Per-node config

For example, in `config/osu-mgr.yaml`:

```yaml
thumbnails:
  sources:
    - name: collection
      bucket: osu-corelab-storage
      region: us-west-2
      prefixes: ["Collection/Holdings/", "Collection/ACC Holdings/",
                 "Collection/Oregon Drill Core Holdings/"]
      inventory:                     # what the daily sweep reads
        bucket: osu-corelab-storage-inventory
        configs: [collection-holdings, collection-acc-holdings,
                  collection-oregon-drill-core-holdings]
      withheld:                      # never rendered; existing thumbnails are withdrawn
        path_patterns:               # the moratorium folder suffix
          - '(?i)^Collection/[^/]*Holdings/[^/]+-moratorium/'
        prefix_lists:                # the moratorium spreadsheet
          - { key: Collection/moratorium.xlsx, header_rows: 2, column: 0 }
  file_types:                        # key patterns, first match wins (FILE_TYPES, ported)
    core-image:       { render: image, match: ['(?i).*?Holdings/[^+#][^/]+?/image/OSU-([^/~]*?)-image\.(tif|tiff|bmp|jpg|jpeg|png)$'] }
    whole-rock-image: { render: image, match: ['...'] }
    core-description: { render: pdf,   match: ['...'] }
    igsn-sheet:       { render: pdf,   match: ['...'] }
    # ... every image and PDF type in the pipeline's _THUMBNAIL_*_TYPES
  hidden_types: [igsn-sheet, imlgs-file, itrax-xray-image]   # the site's hiddenFileTypes
  max_source_bytes: 1073741824       # larger sources get a skipped marker
  max_pixels: 2000000000             # a decode ceiling that replaces Pillow's bomb check
```

- **Validation**, at load time and before every publication, as `CLAUDE.md`
  requires:
  - each regex compiles;
  - `render` is `image` or `pdf`;
  - every `file_types` key and every `hidden_types` entry is a term in the
    node's `file_type` controlled vocabulary.
  The vocabulary check catches the inconsistency that exists today: the pipeline
  renders `igsn-sheet` PDFs, but the site hides them.
- **Sizes, format and quality are not per node.** They belong to the render
  profile `r1`, which is part of the URL. Callers then need nothing but
  (bucket, key, ETag) to build a URL. To change output, cut a new profile
  (`r2`) and let the sweep re-render; old URLs stay valid until they are deleted.
- **How the Lambda gets the policy.** A node's served config is its published
  revision in Postgres, and the Lambda cannot reach Postgres. So FIESTA writes
  the resolved, validated section to `earthref-thumbnails/policies/<slug>.json`
  (not under `t/`, so not publicly readable). It does this in
  `fiesta thumbnails publish-policy`, which runs from `fiesta init` and on
  node-config publication once the deployment has thumbnail credentials; until
  then an operator runs it. The Lambda re-reads the policy when it is older than
  5 minutes, with a conditional GET. It **fails closed**: if the policy or a
  moratorium list cannot be read, it renders nothing, deletes nothing and logs
  an error.
- **The ported `FILE_TYPES` patterns are a second copy** of the pipeline's list
  until the pipeline reads them back from the published policy (a note for the
  OSU-MGR repos below).

## Key and URL scheme

```
S3 key : t/{profile}/{bucket}/{key}/{etag}/{size}.webp
URL    : {base}/t/{profile}/{bucket}/{percent-encoded key}/{etag}/{size}.webp

profile  r1                                  (the render profile; bump it to change output)
bucket   the source bucket                   osu-corelab-storage
key      the source object key, unchanged    Collection/ACC Holdings/…/OSU-…-image.tif
etag     S3 ETag, quotes stripped, lower-case 5d41402abc4b2a76b9719d911017c592 (or "…-12" if multipart)
size     thumb | preview
base     https://thumbs.earthref.org         (deployment setting, not per node)
```

- **Encoding.** Percent-encode the key as UTF-8, leaving only RFC 3986
  unreserved characters and `/` literal (Python `quote(key, safe="/")`,
  JavaScript `encodeURIComponent` per `/`-separated segment). `+` becomes `%2B`
  and a space becomes `%20`; CloudFront passes the path through and S3 decodes
  it. A key is skipped, with a marker, if it has an empty, `.` or `..` segment,
  or if it is longer than 900 bytes (so the thumbnail key stays under S3's
  1024-byte limit).
- **The path is readable, not hashed**, for three reasons:
  - Withdrawal is a prefix delete, plus one CloudFront wildcard invalidation per
    moratorium prefix.
  - The pipeline can list exactly one cruise's thumbnails.
  - Operators can read the bucket.
  The source paths are already public on the OSU-MGR site. A moratorium path
  cannot be discovered through this scheme, because its thumbnails never exist.
- **One version per key.** When the key's ETag changes, `reconcile()` renders
  the new ETag's folder, then deletes the old one and invalidates it. The
  invalidation matters when a file is replaced because its old content must not
  be shown.
- **Write order.** The preview is written first and `thumb.webp` last, so the
  existence of `thumb.webp` means both are complete. A failure writes
  `{etag}/error.json` and a size or format skip writes `{etag}/skipped.json`. The
  sweep does not retry those until the profile or the ETag changes.
- Object metadata: `source-etag`, `width`, `height`, `renderer` (the package
  version), and `Content-Type: image/webp`.

### How a caller learns what exists

- **With the ETag** (the pipeline lists sources, and FIESTA stores ETags), the
  URL is a string format. With `earthref-thumbnails` installed without extras,
  it is `thumbnail_url(bucket, key, etag, size)`.
- **Which files have one.** List `t/r1/{bucket}/{prefix}` once and keep the keys
  that end in `/thumb.webp`. At 1,000 keys per request, all of OSU-MGR (about
  55k thumbnails plus previews) takes about 110 LIST calls, which is under
  $0.001. The listing also carries each key's current ETag, so a caller that
  does not keep ETags can take them from here. The caller needs `s3:ListBucket`
  on that prefix, which is an operator IAM grant for the pipeline's user.
  `earthref_thumbnails.existing(s3, bucket, prefix)` returns `{key: etag}`.

## Visibility

**Rule: a thumbnail exists only while its source is public.** `reconcile()`
checks visibility on every run, and the sweep re-checks the whole collection
every day. Nothing else writes to the `t/` prefix.

- **OSU-MGR moratorium.** A file is withheld when either of these holds, as in
  `_is_moratorium()` in the pipeline:
  - its cruise folder ends in `-moratorium`;
  - its key starts with a prefix listed in `Collection/moratorium.xlsx`.
  The spreadsheet's end dates are not acted on automatically, and the pipeline
  ignores them too: a moratorium ends when the row is removed or the folder is
  renamed.
  - **Lifting by rename.** S3 has no rename, so the new keys arrive as
    `ObjectCreated:Copy` events and render. The old keys are withheld and have
    no thumbnails. Thumbnails appear as soon as the new path exists, in seconds
    to minutes.
  - **Imposing a moratorium** (renaming into `-moratorium`, or adding a row):
    the `ObjectRemoved` events, or the spreadsheet's own `ObjectCreated` event,
    trigger a delete of each affected key's folder plus a CloudFront
    invalidation. The Lambda keeps the last moratorium list it applied in
    `state/<slug>/withheld.json` (not public), so a spreadsheet change is a diff.
  - **Worst case**, if an event is lost: the sweep fixes it within a day. An
    edge copy lives at most 1 day (CloudFront max TTL 86400), even without an
    invalidation.
- **Hidden types** (`hidden_types`) are never rendered, whatever their path.
- **FIESTA contributions** (phase 2): the worker renders the files of an
  activated contribution only, and withdraws them on deactivation or deletion.
  Private and private-key contributions get no thumbnail; the UI falls back to
  an icon. A private preview would need an authenticated proxy, which is out of
  scope.
- **Serving.** CloudFront reads the bucket only through Origin Access Control
  (OAC), and the bucket policy allows it `s3:GetObject` on
  `arn:aws:s3:::earthref-thumbnails/t/*` alone. `policies/` and `state/` stay
  private, Block Public Access stays on, and the source buckets are untouched:
  the Lambda role can only read them.
- **Found while surveying, outside this design.** The OSU-MGR website's
  `pages/api/file/[...path].ts` streams any key in `osu-corelab-storage`
  without authentication, moratorium files included. Only the UI hides the
  links. See the notes for the OSU-MGR repos below.

## Rendering

The package is `earthref_thumbnails.render`. It is pure: bytes in, two WebP
buffers out. It decodes once, at preview size, and derives the thumbnail from
the preview.

| Input | Decoder | How it shrinks while loading |
|---|---|---|
| TIFF (strip, multi-frame CT, 16-bit) | pyvips `thumbnail("f.tif[page=N]", 2048, height=2048, size=down)` | Streams strips sequentially with block shrink, so a 479 MB TIFF never sits in memory. A multi-frame file uses page `n_pages // 2`, the middle frame, as the pipeline does. |
| JPEG, PNG | pyvips `thumbnail` | libjpeg shrinks by 1/2, 1/4 or 1/8 on load. EXIF rotation is applied and CMYK or ICC colour is converted to sRGB. |
| BMP | Pillow: `open`, then `reduce(k)`, then LANCZOS to the box | BMP has no shrink-on-load, and the libvips build that pyvips ships has no BMP loader. The decode is bounded by `max_pixels` (Pillow's `MAX_IMAGE_PIXELS` is set per call, never globally off). If memory becomes a problem, a streaming path for uncompressed 24-bit BMP (vips `rawload` + `bandfold`) is an option. |
| Anything else pyvips cannot open | the Pillow fallback (`draft()` for JPEG, `reduce` otherwise) | |
| PDF | page 1 via PyMuPDF (or pypdfium2, open decision 5), zoom = `min(2048/w, 2048/h)` | The page renders straight at preview size. |
| CR2, RAW | skipped (`skipped.json`), as the pipeline does | |

- **16- and 32-bit to 8-bit.** A linear stretch between the 0.5th and 99.5th
  percentiles, computed on the already-shrunk image. It is cheap, and one hot
  pixel cannot flatten a CT slice. The pipeline uses min–max; this is a
  deliberate change.
- **Alpha** is flattened onto white. Grayscale stays grayscale.
- **Fit, not fill.** Both sizes fit their box and never upscale:
  - A 20:1 core strip gets a 400 × 20 thumbnail and a 2048 × 102 preview.
  - A 3:4 PDF page gets a 300 × 400 thumbnail and a 1536 × 2048 preview.
  How strips should look on a card is open decision 4.
- **WebP rather than JPEG.** It is about 25–35% smaller at the same visual
  quality, handles grayscale and alpha, and every current browser decodes it
  (Safari since 14, 2020). JPEG is a one-line profile change if a consumer needs
  it.

**Test fixtures**, generated in `conftest.py` rather than committed as binaries:
- a multi-frame 16-bit TIFF (checks the middle frame and percentile stretch);
- a 20:1 strip (checks the box fit);
- a 24-bit BMP;
- a 3-page PDF (checks that only page 1 renders);
- a 400-megapixel compressed TIFF, about 1 MB on disk. It must render within
  the memory and time budget, and it must also be refused, with `skipped.json`,
  when `max_pixels` is set below it.

Other tests: the key, URL and encoding rules; policy classification (types,
hidden types, moratorium suffix and spreadsheet); and `reconcile()` against a
fake S3, covering create, change of ETag, withdrawal and a late `ObjectRemoved`.

## Package and runners

```
thumbnails/                          uv project `earthref-thumbnails`, import `earthref_thumbnails`
  earthref_thumbnails/
    keys.py      thumbnail_key / thumbnail_url / existing()     (no extras: boto3 only)
    policy.py    pydantic models (NodeConfig imports them); classify(bucket, key) → Render | Withheld | Skip
    render.py    decode + encode (extra [render]: pyvips[binary], pymupdf|pypdfium2, pillow, numpy)
    reconcile.py reconcile(bucket, key) against S3; invalidation batching
    sweep.py     inventory × thumbnail listing → work items
    aws_lambda.py handler: SQS batch | EventBridge S3 event | Scheduler sweep | direct invoke
    cli.py       render FILE | reconcile s3://… | ensure s3://prefix | sweep --node … [--dry-run]
  tests/
  lambda/build.sh                    arm64 zip (uv pip install --python-platform aarch64-manylinux2014)
backend/                             depends on it via a uv path source; `fiesta thumbnails publish-policy`
```

**Lambda sizing** (to confirm in the pilot):

| Setting | Value |
|---|---|
| Architecture and runtime | arm64, Python 3.12, zip package (under 250 MB unpacked; no ECR needed) |
| Memory | 3,008 MB |
| Ephemeral storage | 2 GB (the source downloads to `/tmp`; the largest is 479 MB) |
| Timeout | 5 min |
| SQS | batch size 1, event-source maximum concurrency 100, visibility timeout 6 min, dead-letter queue after 3 attempts |

A streaming read (pyvips `SourceCustom` over ranged GETs) is a possible
optimisation, not a starting point.

**Phase 2, FIESTA's worker.** A procrastinate task
`render_thumbnails(node, contribution_id)` goes on the node's queue. The
outbox enqueues it after activation, and deactivation or deletion enqueues its
withdrawal. It calls `reconcile()` with a visibility callback that reads
Postgres instead of the path rules, and it writes the resulting URLs into the
node's file rows (`files.thumbnail` already exists in the OSU-MGR data model) so
search documents carry them. Nothing needs this until a node stores per-file
bytes in FIESTA (ERDA's object bytes are a known gap), so it is designed here
but not in v1.

## Backfill: plan, cost and time

1. **Pilot, locally, read-only.** Run `earthref-thumbnails render` on one
   cruise, using the pipeline's credentials read-only and writing to the
   scratchpad. Report output sizes, timings (local, not Lambda) and a few
   rendered examples. That is a few GB of egress, under $0.50. Nothing is
   written to any bucket.
2. **Operator creates the AWS pieces** (OPERATOR_TODO, after approval).
3. **Lambda pilot.** Run `sweep --node osu-mgr --prefix Collection/Holdings/<cruise>/`,
   then check the Lambda's durations, memory and outputs through CloudFront.
4. **Full backfill.** The first unrestricted sweep. Then turn on the daily
   Scheduler and the EventBridge rule.

**Estimate for about 55,400 files** (31.9k images and 23.5k PDFs), at
arm64 $0.0000133 per GB-second and 2.94 GB:

| Item | Assumption | Cost |
|---|---|---|
| Core images, 18.3k | about 5 s each (in-region GET about 1 s, strip decode 2–4 s; about 15 s for the 479 MB largest) | $3.6 |
| Other images, 13.6k | about 1.5 s each (JPEG shrink-on-load) | $0.8 |
| PDFs, 23.5k | about 1 s each | $0.9 |
| S3 requests | 55k GET, 111k PUT, LIST and HEAD | $0.6 |
| SQS, Lambda requests, CloudWatch Logs | | about $0.6 |
| **Total** | | **about $7** (under $10 even if the per-file times double) |
| Time | 135k compute-seconds at 100 concurrent | **about 25 min** |
| Stored output | about 55k × (20 KB thumbnail + 250 KB preview), about 15 GB | about $0.35 a month |

**Steady state.** New uploads cost fractions of a cent. The daily sweep reads
the inventory and makes about 110 LIST calls, also negligible. CloudFront
delivery is covered by its free tier (1 TB a month) at OSU-MGR's traffic.

## Build scope after approval (v1)

1. `thumbnails/` package with the tests above; `make test` and `ci.yml` run them.
2. `NodeConfig.thumbnails` plus loader checks. `config/osu-mgr.yaml` gets the
   section, ported from `FILE_TYPES`, `_THUMBNAIL_*_TYPES` and `hiddenFileTypes`.
3. `fiesta thumbnails publish-policy`, and `lambda/build.sh`.
4. The pilot on one cruise, with the report.
5. `docs/OPERATOR_TODO.md` entries with exact settings: bucket, OAC,
   distribution, ACM certificate and DNS, IAM role, Lambda, SQS and DLQ,
   EventBridge rule and Scheduler, the pipeline user's `ListBucket` grant,
   the ETag field on the inventories, and the Lambda concurrency limit.
6. Notes for the OSU-MGR repos, in the next section.

Not in v1:
- the FIESTA worker runner (phase 2);
- spreadsheets and CSVs (`xrf-data`, `mst-data`, dredge-log xlsx; about 1.8k
  files). These would need headless LibreOffice in a Lambda container image, or
  a rendered "first rows" table instead of a picture;
- deep-zoom tiles for core strips;
- private previews.

## Notes for the OSU-MGR repos (not edited from FIESTA)

**osu-mgr-pipeline**
- Remove `generate_thumbnails()`, `THUMBNAIL_PREFIX` and the
  `Collection/Thumbnails/` writes. Keep `--no-thumbnails` as a no-op flag for
  one release.
- After `classify_files()`, call `existing(s3, "osu-corelab-storage", "Collection/")`
  once per run; incremental runs list only the changed cruise prefixes. Then set
  `thumbnail` and `preview` URLs on each `_files` entry whose path has a
  `thumb.webp` at its current ETag. `_parentFiles` and `_childFiles` inherit
  them, because `denormalize()` copies the entries.
- Add `thumbnail` and `preview` (keyword, `index: false`) to the `_files`,
  `_parentFiles` and `_childFiles` mappings. The pipeline already builds a fresh
  dated index per full run, so no reindex is needed.
- Depend on `earthref-thumbnails` without extras (a git subdirectory
  dependency), or copy the ten lines of `keys.py`. Later, read `FILE_TYPES` and
  the hidden types from the published policy instead of keeping a second copy.
- Rotate the OpenSearch credential hard-coded in `OPENSEARCH_HOST`.
  `docs/osu-mgr-node.md` already flags it.

**osu-mgr-website**
- Type the entries as `{type, path, thumbnail?, preview?}` (today only
  `FileCardProps` is typed; everything else is `any`).
- **`FileCard`**: use `file.thumbnail` when present, otherwise today's icon.
  - Switch `object-cover` to `object-contain` on a neutral background, or a 20:1
    strip is cropped to a sliver.
  - Add `loading="lazy"` and `decoding="async"`.
  - An `onError` handler falls back to the icon, for a thumbnail withdrawn after
    the index was built.
- **`FileRow`**: show `file.preview` instead of the full original (it loads
  `/api/file/...` at natural size today). TIFFs and PDFs get a picture for the
  first time. Keep "Download original" on `/api/file/...`.
- Move `hiddenFileTypes` and `moratoriumCruises` off hand-kept lists, to the
  published policy and the index's `_moratorium` flag.
- **Close the proxy gap.** `/api/file/[...path]` should refuse withheld keys
  (the `-moratorium` suffix and the spreadsheet prefixes) and hidden types
  server-side.

## Open decisions

1. **Where FIESTA's worker runs.** Inferred to be on-premises at OSU from
   `dev.earthref.org` (128.193.72.23) and "self-hosted on the deploy host". If it
   is in fact in us-west-2, a procrastinate runner becomes viable, though the
   inventory sweep and moratorium events still favour a Lambda.
2. **The AWS account** for the Lambda, the thumbnail bucket and CloudFront.
   Recommended: the account that owns `osu-corelab-storage`, so events and reads
   stay in one account. Also confirm the region of FIESTA's production bucket,
   for phase 2.
3. **A dedicated bucket or a prefix inside the source bucket.** A dedicated
   `earthref-thumbnails` is recommended: one distribution serves every node, and
   a policy typo cannot expose source data. The alternative is
   `osu-corelab-storage/Thumbnails/` with OAC scoped to it, which avoids the new
   `ListBucket` grant for the pipeline.
4. **Core strips on cards.** Plain fit (recommended; the site switches to
   `object-contain`), or a profile option that folds a strip longer than 4:1
   into side-by-side segments, like a core-box photo. Also decide whether strip
   previews get a larger long side (for example 4096) for the modal. Decide
   after seeing the pilot's examples.
5. **PDF renderer licence.** PyMuPDF is AGPL-3.0; FIESTA is MIT. Using it
   unmodified in a Lambda is probably fine, but pypdfium2 (Apache-2.0/BSD)
   renders page 1 as well and removes the question. Recommended: pypdfium2.
6. **Hostname**: `thumbs.earthref.org` (recommended), or a per-node name.
7. **The ETag field on the three S3 inventories.** Without it, the sweep can
   find missing and orphaned thumbnails but not a changed file whose event was
   lost. Recommended: turn it on.
8. **Duplicate formats.** The pipeline indexes one format per
   (OSU-ID, type): jpg, then png, then bmp, then tif. The service renders every
   matching object, so where a JPEG and a TIFF of one image both exist, both get
   thumbnails. That is simpler and costs little. The alternative is for the
   sweep to skip the losers, which puts that ranking in the policy.
