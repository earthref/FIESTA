# The KdD node

GERM's Partition Coefficients Database ([earthref.org/KdD](https://earthref.org/KdD))
archives mineral/melt partition coefficients (Kd) from experimental and
empirical studies, ported from the Meteor app in the sibling `KDD` repository.

Key `KdD`, slug `kdd`, index `kdd`, DOI prefix `10.7288/V4/KDD`.
Configuration: [`../kdd.yaml`](../kdd.yaml).

## Data model

Version 1.0 in `data_models/`: two tables, `contribution` and `kds` (one row per
partition coefficient). `kds.element` holds element symbols (`Sm`, `Ce`, …).

## Vocabularies

`controlled_vocabularies.json`.

## Search

Levels: Contributions and Partition Coefficients (`kds`, counted by
`summary.kds._n_results`). Sidebar filters, as the legacy app's: Publication
Year, Rock Type, Mineral, Kd Definition and Kd Type, plus every node's
contribution filters; the periodic table is the element filter (the legacy
"Element Name" list is left out).

## Plugins

| Plugin | What it adds |
|---|---|
| [periodic-table](../plugins/periodic-table/README.md) | the Periodic Table filter, counting `kds.element` under the current search |
| [sample-tiles](../plugins/sample-tiles/README.md) | the Geology, Age, Intensity and Method Codes grid tiles (KdD has no data for them; they show "No … Data") |

## Data source

[`../sources/kdd.py`](../sources/kdd.py) mirrors the legacy index until cutover.
Legacy contributions carry only the display name "Roger Nielsen", so the sync
takes an owner map (gitignored, outside the repo); see
[docs/OPERATOR_TODO.md](../../docs/OPERATOR_TODO.md) and
[docs/data-sources.md](../../docs/data-sources.md).
