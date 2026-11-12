# The MagIC node

The Magnetics Information Consortium ([earthref.org/MagIC](https://earthref.org/MagIC))
archives paleomagnetic and rock magnetic data: contributions of locations,
sites, samples, specimens and measurements, ported from the Meteor app in the
sibling `MagIC` repository.

Key `MagIC`, slug `magic`, index `magic`, DOI prefix `10.7288/V4/MAGIC`.
Configuration: [`../magic.yaml`](../magic.yaml).

## Data model

Versions 2.2–2.5 and 3.0 (latest) in `data_models/`, converted from the legacy
repo's JSON. Gotchas: 3.0 has no `experiments` table (it is a derived search
level); longitudes are 0–360; `lab_names`, `citations`, `geologic_types`,
`lithologies`, `age_unit` and `reference` are required, so fixtures and seeds
must fill them.

## Vocabularies

`controlled_vocabularies.json` and `suggested_vocabularies.json`, plus
`method_codes.json` (the method-code list the `method-codes` plugin serves and
validates against) and `plate_boundaries.json`.

## Search

Levels: Contributions, Locations, Sites, Samples, Specimens, Measurements.
Numeric range filters on the sidebar. Lunar locations (`location_type: Lunar`)
map onto the Moon basemap (`search.bodies`).

## Plugins

| Plugin | What it adds |
|---|---|
| [poles](../plugins/poles/README.md) | a Poles search level from locations' `pole_lat`/`pole_lon`, with its map |
| [rock-mag](../plugins/rock-mag/README.md) | a Rock Magnetism search level derived from specimen results |
| [pmag-plots](../plugins/pmag-plots/README.md) | interactive PmagPy plot tabs in the contribution modal (the legacy site's cached plot images, drawn live) |
| [method-codes](../plugins/method-codes/README.md) | the Method Codes page and home card, code definitions in facet lists, method-code validation |
| [sample-tiles](../plugins/sample-tiles/README.md) | the Geology, Age, Intensity and Method Codes grid tiles |

## Content pages

`pages/` holds About, Technology, Grand Challenges, Workshops, Links, Help,
Jupyter Notebooks and the upload help pages; images live in `assets/`.

## Data source

Until the Meteor cutover the node mirrors the legacy app:
[`../sources/magic.py`](../sources/magic.py), hourly (`legacy.sync`,
`40 * * * *`). See [docs/data-sources.md](../../docs/data-sources.md).
