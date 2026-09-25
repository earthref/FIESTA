"""Node plugins — isolated node-specific features.

A plugin packages everything a node-specific feature needs on the backend:
derived search documents, extra search levels, API routes, and the metadata
the frontend uses to activate its UI counterpart. Plugins are activated per
node by the deployment YAML (`features.plugins: [poles, depth-plot, ...]`);
the code for every plugin ships with FIESTA, but only activated plugins run.

Adding a plugin:
1. Subclass FiestaPlugin in fiesta/plugins/<name>.py
2. Register it in PLUGINS below
3. Reference it from a node YAML under features.plugins
4. (Optional) register a UI component under the same name in the frontend's
   src/plugins/ registry.
"""

from fiesta.plugins.base import FiestaPlugin


def _registry() -> dict[str, FiestaPlugin]:
    from fiesta.plugins.depth_plot import DepthPlotPlugin
    from fiesta.plugins.plateau import PlateauPlugin
    from fiesta.plugins.poles import PolesPlugin
    from fiesta.plugins.record_cards import RecordCardsPlugin

    plugins = [PolesPlugin(), DepthPlotPlugin(), PlateauPlugin(), RecordCardsPlugin()]
    return {plugin.name: plugin for plugin in plugins}


_PLUGINS: dict[str, FiestaPlugin] | None = None


def all_plugins() -> dict[str, FiestaPlugin]:
    global _PLUGINS
    if _PLUGINS is None:
        _PLUGINS = _registry()
    return _PLUGINS


def active_plugins(node) -> list[FiestaPlugin]:
    """The plugins a node's YAML activates, in YAML order, with their options
    validated. Unknown names (in `features.plugins` or `plugins`) and options
    that do not fit a plugin's schema are a config error — fail loudly at
    startup and in the admin UI's validation, not silently at request time.
    Options of a plugin that is configured but switched off are checked too,
    so switching it back on cannot fail."""
    plugins = all_plugins()
    missing = [name for name in [*node.features.plugins, *node.plugins] if name not in plugins]
    if missing:
        raise ValueError(
            f"node {node.node.key!r} names unknown plugins {sorted(set(missing))}; "
            f"known: {sorted(plugins)}"
        )
    for name in {*node.features.plugins, *node.plugins}:
        plugin = plugins[name]
        plugin.check(node, plugin.options(node))
    return [plugins[name] for name in node.features.plugins]
