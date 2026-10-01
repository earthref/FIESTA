# The SC node

The Seamount Catalog ([earthref.org/SC](https://earthref.org/SC/)) is the
Seamount Biogeosciences Network's archive of seamount morphology: for each
seamount its location, plate and setting, size and shape, the contour-by-contour
measurements behind those numbers, the bathymetric maps and grids they were
measured from, ERDA files about it, and the literature on it in the EarthRef
Reference Database (ERR). The legacy catalog is a Perl CGI app (`sc-s1-advanced.cgi`
and friends) over the classic `er_*` schema; this node ports it onto FIESTA.

Key `SC` (the legacy path), slug `sc`, index `sc`, bucket prefix `sc/`, colour
SBN blue. `publish.web` is false: the legacy catalog still answers at
`earthref.org/SC/` until cutover, so production serves the API only.

## Data model 1.0

Six tables. One contribution per legacy **region** (a seamount trail, chain or
ocean basin — the catalog's own grouping); every other table hangs off
`seamounts` by its index. More than half the catalog (1,010 seamounts, most of
them named) has no region and almost always no
plate either; those make one contribution of their own ("Seamounts outside the
catalog's regions") rather than an invented grouping. The only other grouping
the legacy data offers is the map sheet each seamount was drawn on (`SC00`–`SC16`,
from the image paths), which has no names.

As of 2026-09-30 the catalog is **1,847 seamounts in 33 contributions**, with
846 contours, 3,649 maps, 111 ERDA files and 134 references; 891 seamounts have
search-row data and 322 a description.

```
contribution            one per region
└── seamounts           key: seamount (the SMNT index)
    ├── contours        seamount → one row per measured depth contour
    ├── maps            seamount (one-seamount maps) + seamounts (every seamount it covers)
    ├── files           seamounts → ERDA files
    └── references      seamounts → ERR publications
```

`seamounts` is the catalog record. `contours`, `files` and `references` are the
legacy page's collapsible sections. A **map** is one legacy file group: the
same file id is listed under "Bathymetric Maps" when it has an image and under
"Grid Files" when it has a grid, so the two legacy lists are one table here
with `products` = `Map`, `Grid` or `Map:Grid`. A map of one seamount names it in
`seamount` (and so takes its position); a regional map (a trail overview, a
tile, a blowup) leaves `seamount` empty and lists every seamount whose page
linked it in `seamounts`. ERDA files and references are shared the same way.

### Mapping from the legacy record

| Legacy field | Column | Notes |
|---|---|---|
| Index | `seamounts.seamount` | `SMNT-453S-1575W`: summit latitude/longitude ×10 |
| name + class (`smnt_name`, `smnt_class`) | `seamount_name` | the legacy title, e.g. `157.5°W Guyot`, `Johnston Seamount` |
| Alternative Names | `alternative_names` | split on the legacy commas |
| Classification | `size_class`, `shape_class`, `seamount_type` | `Intermediate A3 Guyot` → `Intermediate`, `A3`, `Guyot` |
| Location (D° M.MM' H) | `lat`, `lon` | decimal degrees, longitudes −180–180 |
| Region, Plate | `region`, `plate` | suggested vocabularies |
| Tectonic Setting, Oceanic Province, Volcanic Activity | same names | controlled vocabularies; the legacy spellings "Hotspot Trails", "Hotpot Trails" and "Hotpost Trails" become `Hotspot Trail` |
| Plate Age (`a - b Ma`) | `plate_age_min`, `plate_age_max` | |
| Age, Height, Volume | `age`, `height`, `volume` | Ma, m, km³ |
| Seamount Top, Ocean Bottom, Shelf Edge | `summit_depth`, `base_depth`, `shelf_edge_depth` | m |
| Elongation, Irregularity (`x ± s`) | `elongation`(`_sigma`), `irregularity`(`_sigma`) | irregularity can be below 1 in the legacy data, so it is bounded at 0 only |
| Number of Summits, Multibeam Coverage, Description | `n_summits`, `multibeam_coverage`, `description` | only on search result rows (or the morphology section) |
| `sc_smnt_id` | `sc_id` | the legacy id |
| Morphology table | `contours` | Depth, Azimuth, Area, Length, Width, Elongation, Contour, Ellipse, Irregularity |
| Bathymetric Maps / Grid Files | `maps` | title, `file_id` → `sc_file_id`, image name, grid spacing and pixel size from the viewer link |
| ERDA Files | `files` | title, ERDA id, `earthref.org/ERDA/<id>/` |
| References | `references` | ERR id (the key), citation, `earthref.org/ERR/<id>/` |

## Vocabularies

`config/sc/controlled_vocabularies.json` — `boolean`, `sc_version`,
`seamount_type`, `size_class`, `tectonic_setting`, `oceanic_province`,
`volcanic_activity`, `scale`, `bathymetry_type`, `map_product`: every value the
legacy catalog uses, no more.

`config/sc/suggested_vocabularies.json` — `region`, `plate`, `shape_class`:
the catalog's values, as warnings, since new seamounts bring new regions.

## Search

Levels: **Contributions**, **Seamounts**, **Maps**, **References** (contours
and ERDA files are searchable types without a tab). Facets: seamount type, size
class, region, plate, tectonic setting, oceanic province, volcanic activity,
bathymetry type, map scale and products — the legacy search's plate / region /
setting selectors plus the classifications it displayed. The Seamounts grid
leads with name, type, size, region and plate, then position and the
headline morphology.

## Known gaps

- **Map and grid files.** The images were served from
  `erda.sdsc.edu/maps/<area>/JPG/`, which is gone (404), and the grids and raw
  multibeam behind `sc-s3-download.cgi` resolve to no reachable file;
  earthref.org answers those paths with its HTML catch-all. The node catalogues
  every map (title, file name, legacy file id, size) but holds no bytes until
  the files are found on legacy storage (OPERATOR_TODO).
- **Numeric range search.** Height, depth, volume and age are `Number`
  columns, but the shared index mapping types row values as text, so range
  filters on them need the explicit numeric mapping ERDA's age range also
  waits for (`fiesta/search/index.py`).
- **Contributors.** The pages name no per-region author or DOI, so imported
  contributions carry neither, and `fiesta sync-legacy` assigns them to a
  steward account.

## Legacy import

`scripts/sc-legacy-catalog.py` reads the public pages (standard library only;
`--help` has the options). There is no structured source FIESTA can reach, the
same as ERDA, and SC has no contributions to import record by record — the
contributions are built here, one per region:

1. **Ids.** The home page's seamount menu lists 1,608 ids; seventeen broad
   searches (plate "Plate", regions "Pacific", "Trail", …; the server refuses
   terms under five letters) add the 239 seamounts the menu leaves out.
   Sampled ids outside that union return nothing.
2. **Pages.** `sc-s1-advanced.cgi?sc_seamount_id=<id>` returns the seamount's
   full page (a one-hit search skips the result list). Search result rows add
   height, multibeam coverage, number of summits and the description, which the
   page lacks; for the seamounts no search reaches, the morphology section
   supplies the first three when it exists.
3. **Text.** The pages are Latin-1 bytes mixing UTF-8 `º`/`±` with a bare
   `0xBF` for the degree sign; all three become `°`/`±`.

Every response is cached under `--cache`, so re-runs are offline. The server
drops requests whose User-Agent does not look like a browser.

- `--seeds config/sc/seeds` writes `catalog/<region>.txt` and the `catalog-*`
  entries of `seeds/manifest.yaml`, so `make up FIESTA_NODE=sc` serves the
  whole catalog locally.
- `--inventory ../migration/sc --owner <steward email>` writes `records/` and
  `inventory.json` for `fiesta sync-legacy` (contribution ids 1…N, largest
  region first; the owner email is a run argument, never checked in).
