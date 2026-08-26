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

    plugins = [PolesPlugin(), DepthPlotPlugin(), PlateauPlugin()]
    return {plugin.name: plugin for plugin in plugins}


_PLUGINS: dict[str, FiestaPlugin] | None = None


def all_plugins() -> dict[str, FiestaPlugin]:
    global _PLUGINS
    if _PLUGINS is None:
        _PLUGINS = _registry()
    return _PLUGINS


def active_plugins(node) -> list[FiestaPlugin]:
    """The plugins a node's YAML activates, in YAML order. Unknown names are
    a config error — fail loudly at startup, not silently at request time."""
    plugins = all_plugins()
    missing = [name for name in node.features.plugins if name not in plugins]
    if missing:
        raise ValueError(
            f"node {node.node.key!r} activates unknown plugins {missing}; "
            f"known: {sorted(plugins)}"
        )
    return [plugins[name] for name in node.features.plugins]
