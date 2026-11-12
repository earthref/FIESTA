# The CDR node

The Core Data Repository ([earthref.org/CDR](https://earthref.org/CDR)) archives
sediment and rock core data: cores, their sections and the measurements down
them, ported from the Meteor app in the sibling `CDR` repository.

Key `CDR`, slug `cdr`, legacy index `cdr-3`, DOI prefix `10.7288/V4/CDR`.
Configuration: [`../cdr.yaml`](../cdr.yaml).

## Data model

Version 1.0 in `data_models/`, extended with every table and column the legacy
`cdr-3` index carries. No CDR 3.0 model exists, so every legacy record imports
as 1.0 (`legacy.data_model_version`). Only `cdr-3` is imported; the 58
contributions in the older `cdr`/`cdr-2` alias are left behind (decided
2026-09-28).

## Vocabularies

`controlled_vocabularies.json` and `suggested_vocabularies.json`.

## Search

Levels: Contributions, Cores, Sections, Measurements, with facet filters on the
sidebar.

## Plugins

| Plugin | What it adds |
|---|---|
| [depth-plot](../plugins/depth-plot/README.md) | measurements plotted down core depth |
| [sample-tiles](../plugins/sample-tiles/README.md) | the Geology, Age, Intensity and Method Codes grid tiles |

## Data source

[`../sources/cdr.py`](../sources/cdr.py) mirrors `cdr-3` until cutover. CDR has
no S3 buckets, so every record exports from the index. CDR #88 is unactivated in
`cdr-3` and is withheld. See [docs/data-sources.md](../../docs/data-sources.md).
