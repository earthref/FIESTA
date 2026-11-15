# RD — GERM Reservoir Database

The GERM Reservoir Database (https://earthref.org/GERMRD/) holds summary data on
the geochemistry of the Earth's reservoirs, compiled from the peer-reviewed
literature for the Geochemical Earth Reference Model (GERM): element
concentrations, isotope compositions and element ratios for reservoirs from the
solar system and meteorites to the mantle, crust, rivers, seawater and the
atmosphere. Its sibling is the GERM partition coefficient database, KdD. The
legacy site is a frozen EarthRef CGI application (its last new data are from
2006), so this node mirrors it rather than syncing a living source.

## Shape

| FIESTA | GERMRD |
|---|---|
| contribution (one per reservoir) | a reservoir; the contribution ID is the GERMRD reservoir ID (`/GERMRD/<id>/`) |
| `values` rows | the reservoir's values, one per row of its search results |

735 reservoirs with 32,046 values (2026-11-15). A reservoir is not one paper:
the global ones compile many (Seawater, 424 values from about 15 publications;
Upper Continental Crust, 1,000), so **each value carries its own reference**
(`citation`, `reference` DOI, `err_reference_id`, `source_table`, `sources`), and
the contribution lists its `citations` and carries a `reference` DOI only when all
its values come from one publication with a DOI (360 of the 735). Reservoir names
repeat (Andesites, Basalts) where several publications each describe one; each is
its own legacy reservoir, so its own contribution.

The node runs in data-source mode: `configurations/sources/rd.py` writes it through
`/v2/rd/source` (docs/data-sources.md), and nobody uploads to it in FIESTA.
`publish.web: false` keeps it off production's SPA and portal until it is signed off.

## Data model (`data_models/1.0.json`)

Converted from the legacy search results and their "Tab delimited text file"
download (GERMRD has no Meteor model); each column's `previous_columns` names the
legacy column its sort links used (`name_long`, `er_element_id`, `er_unit_id`,
`er_citation_label`, …).

- `element` holds element symbols (`La`), isotopes (`143Nd/144Nd`, `3He`, `d18O`
  for δ¹⁸O, `e-Nd` for εNd) and element ratios or indices (`La[n]/Yb[n]`, `Mg#`,
  `Eu/Eu*`), as the legacy did; `z` is the atomic number where the legacy gave one.
- `quantity` (Element, Isotope, Ratio) is derived by the sync, since the legacy
  search's element / isotope split was only in its menus: Isotope by notation
  (mass number, `d`, `e`), Element by symbol or atomic number, otherwise Ratio.
- `value`, `median`, `sd`, `low`, `high`, `n`, `unit` and `computation` are the
  legacy columns. Most values have only `value`; `unit` is blank for ratios and
  isotope compositions and, for 2,089 element values, simply missing in the legacy.
- `notes` is the legacy row's description (the results page's info popup).
- `inserted` is the legacy insertion date (1996–2006), and dates the records: a
  contribution's creation is its first value's, its revision its last value's.

The `units` (`ppm`, `wt%ox`, `µg/g`, …) and `quantities` vocabularies are checked
with `cv()`; computation is free text (the legacy has both "Composite Analysis"
and "Composite Analyses").

## The source (`configurations/sources/rd.py`)

The legacy site has no API, so the script reads its pages into `--state-dir`
(`~/.cache/fiesta/sources/rd`, on the ops host `/var/lib/fiesta-ops/sources/rd`)
before every run, fetching only what is not cached (about 1,500 requests, three at
a time, the first time; `--refresh` re-reads everything):

| File | From | For |
|---|---|---|
| `home.html` | `/GERMRD/` | the reservoir menu: every reservoir ID |
| `reservoirs/<id>.txt` | `/GERMRD/<id>/?…&download_format=txt` | the values (Reservoir … Inserted) |
| `reservoirs/<id>.html` | `/GERMRD/<id>/?…` | per value, in the same order: the ERR reference ID and source table, and the Source(s) |
| `references/<n>.html` | `/ERR/<n>/` | the reference's DOI |

A results page whose rows do not line up with its download fails the run.

```bash
cd fiesta/backend
uv run python ../../configurations/sources/rd.py --fetch           # only cache the pages
uv run python ../../configurations/sources/rd.py --out /tmp/rd     # write the contribution files
FIESTA_SOURCE_EMAIL=… FIESTA_SOURCE_PASSWORD=… uv run python ../../configurations/sources/rd.py \
    --api http://localhost:18000 --owner-email <steward> [--dry-run] [--ids 6 847]
```

On the way in: numbers lose the legacy's bare leading point (`.5134` → `0.5134`);
the degree signs the legacy database lost to `¿` come back (`21°N EPR`); dates
become ISO. Not kept: the scanned source tables (`erda.sdsc.edu/bgfiles/…jpg`),
which no longer resolve; `source_table` keeps their IDs.

**Open:** the legacy database also lost two isotope names to `¿`: `¿` (1 value,
Depleted Mantle, Rehkämper & Hofmann 1997) and `¿-Pb` (8 values, e.g. Granulitic
Xenoliths, Rudnick & Presper 1990, "calculated from U/Pb ratio"). They are
probably the Pb isotope parameters µ (²³⁸U/²⁰⁴Pb) and κ (²³²Th/²³⁸U); until someone
confirms which, they are kept as written and classed Isotope (OPERATOR_TODO).

## Seeds (`seeds/`)

Seven real reservoirs written by `rd.py --out`: 1 Atmosphere, 116 Amphibolites,
569 21°N EPR, 597 Acapulcoite Primitive Achondrites, 682 Atlantic Seawater, 847
Extreme Depleted D-MORB basalts and 992 Venus Atmosphere (see the manifest). The
whole database is 9 MB of contribution text, loaded by the sync, not the seeds.

## Plugins

`periodic-table` (the legacy home page's periodic-table browse) counts the
`values.element` column; isotopes and ratios are not elements and are not counted.
