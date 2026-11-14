# The KArAr node

The K/Ar and ⁴⁰Ar/³⁹Ar Data Repository ([earthref.org/KArAr](https://earthref.org/KArAr))
archives K/Ar and Ar/Ar geochronology: samples, specimens, the experiments run
on them and their step measurements, ported from the Meteor app in the sibling
`KArAr` repository.

Key `KArAr`, slug `karar`, index `karar`, DOI prefix `10.7288/V4/KARAR`.
Configuration: [`../karar.yaml`](../karar.yaml).

## Data model

Version 1.0 in `data_models/`.

## Vocabularies

`controlled_vocabularies.json` and `suggested_vocabularies.json`.

## Search

Levels: Contributions, Samples, Specimens, Experiments, Measurements; the
sidebar has a filter per column with data (`text`, `numeric`, `exists`). Lunar samples (`location_type: Lunar`) map onto the
Moon basemap (`search.bodies`).

## Plugins

| Plugin | What it adds |
|---|---|
| [plateau-calculations](../plugins/plateau-calculations/README.md) | per-step ages and age plateaus for experiments (a port of the legacy `PlateauCalculations`) |
| [sample-tiles](../plugins/sample-tiles/README.md) | the Geology, Age, Intensity and Method Codes grid tiles |

## Data source

[`../sources/karar.py`](../sources/karar.py) mirrors the legacy app until
cutover; it reads the `karar-contributions` buckets named in `karar.yaml`'s
`legacy:` block. See [docs/data-sources.md](../../docs/data-sources.md).
