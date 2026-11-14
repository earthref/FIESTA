# `sample-tiles` (every node)

The legacy EarthRef result card's sample cells as summary grid tiles, moved out
of core on 2026-11-11:

| Tile (`cell`) | Shows | Sorts / filters on |
|---|---|---|
| `geology` | Class, Type and Lithology lines | the class columns; facets: all three lists |
| `age` | the node's age interval (`summary._interval.<age_interval>`, years BP) as every age is shown (`lib/age.ts`: "12.3 ± 0.4 Ma", "10 – 15 Ma", a span for several; as contributed on hover); without one, the age columns' range and unit as contributed | the interval's median age; without one, the age columns as numbers, text box |
| `intensity` | Int (or Min/Max Int) in nT/µT/mT/T from Tesla, and N | the intensity columns, as numbers |
| `method_codes` | the record's method codes | the codes, facet |

All four are default tiles: a search level without `columns` shows them after
Geography and before Citations (the legacy card's order). Every node switches
the plugin on to keep that grid; a node that does not want the four (KdD, ERDA,
OSU-MGR and SC have none of these columns, so they show "No … Data") can drop
it from `features.plugins`, or a level can list its own `columns`.

They read `summary._all` values, so they need no derived documents and no
reindex. Options (node YAML `plugins.sample-tiles`, defaults are MagIC's
columns): `geologic_class_columns`, `geologic_type_columns`,
`lithology_columns`, `age_interval` (the node YAML's `unit_conversions`
interval, default `age`; the Age tile needs a reindex once a node adds one),
`age_columns` (tried in order) and `age_unit_column` (without that interval),
`intensity_columns` (tried in order), `method_code_columns`.

| File | What |
|---|---|
| `plugin.py` | `SampleTilesPlugin`: options, the tiles and their sort/filter fields |
| `index.tsx` | the UI module: the four tiles (`gridCell`) |
| `test_sample_tiles.py` | the tiles' defaults, options and activation |

See [docs/plugins.md](../../../docs/plugins.md) for the plugin API.
