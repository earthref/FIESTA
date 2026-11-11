# Node plugins

One folder per plugin, holding all of it: `plugin.py` (backend), `index.tsx`
and its views (UI), `test_<name>.py` (tests) and `README.md` (what it does,
its options, its routes). A node switches a plugin on with
`features.plugins: [<name>]` in its YAML and tunes it under `plugins.<name>`.

| Plugin | Node |
|---|---|
| [poles](poles/README.md) | MagIC |
| [rock-mag](rock-mag/README.md) | MagIC |
| [pmag-plots](pmag-plots/README.md) | MagIC |
| [depth-plot](depth-plot/README.md) | CDR |
| [plateau-calculations](plateau-calculations/README.md) | KArAr |
| [periodic-table](periodic-table/README.md) | KdD |
| [method-codes](method-codes/README.md) | MagIC |
| [sample-tiles](sample-tiles/README.md) | every node |

How to write one, the hooks, and how the tooling reaches this folder:
[docs/plugins.md](../../docs/plugins.md). `conftest.py` and `ruff.toml` here
serve every plugin's tests and lint.
