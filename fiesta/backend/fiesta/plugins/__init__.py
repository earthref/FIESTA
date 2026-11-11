"""Node plugins — isolated node-specific features.

A plugin packages everything a node-specific feature needs: derived search
documents, extra search levels, API routes, options, its UI, its tests and
its documentation, all in one folder, `configurations/plugins/<name>/`
(FIESTA_PLUGINS_DIR; docs/plugins.md). Plugins are activated per node by the
deployment YAML (`features.plugins: [poles, depth-plot, ...]`); the code for
every plugin ships with FIESTA, but only activated plugins run.

This package is the plugin API (`base.FiestaPlugin`, `util`) and the
registry. A plugin's `plugin.py` imports as `fiesta.plugins.<name>` with
dashes as underscores (`fiesta.plugins.rock_mag` is
`configurations/plugins/rock-mag/plugin.py`), so tests and other modules import it
like any submodule.

Adding a plugin:
1. Create configurations/plugins/<name>/plugin.py with one FiestaPlugin subclass
   whose `name` is <name> (the folder is the registration)
2. (Optional) configurations/plugins/<name>/index.tsx, default-exporting its UI
   PluginModule (fiesta/frontend/src/plugins/index.tsx)
3. Reference it from a node YAML under features.plugins
"""

import importlib
import importlib.abc
import importlib.util
import inspect
import sys
from pathlib import Path

from fiesta.nodeconfig import CORE_GRID_CELLS
from fiesta.plugins.base import FiestaPlugin


def plugins_dir() -> Path:
    from fiesta.settings import get_settings

    return get_settings().plugins_path


def _plugin_folders() -> dict[str, Path]:
    """Module name (`rock_mag`) -> the plugin's folder (`.../rock-mag`)."""
    root = plugins_dir()
    folders = sorted(path.parent for path in root.glob("*/plugin.py"))
    return {folder.name.replace("-", "_"): folder for folder in folders}


class _PluginFinder(importlib.abc.MetaPathFinder):
    """Resolves `fiesta.plugins.<module>` to `<plugins_dir>/<name>/plugin.py`."""

    prefix = f"{__name__}."

    def find_spec(self, fullname, path=None, target=None):
        if not fullname.startswith(self.prefix) or "." in fullname[len(self.prefix) :]:
            return None
        folder = _plugin_folders().get(fullname[len(self.prefix) :])
        if folder is None:
            return None
        return importlib.util.spec_from_file_location(fullname, folder / "plugin.py")


if not any(isinstance(finder, _PluginFinder) for finder in sys.meta_path):
    sys.meta_path.append(_PluginFinder())


def _registry() -> dict[str, FiestaPlugin]:
    plugins: dict[str, FiestaPlugin] = {}
    for module_name, folder in _plugin_folders().items():
        module = importlib.import_module(f"{__name__}.{module_name}")
        classes = [
            cls
            for _, cls in inspect.getmembers(module, inspect.isclass)
            if issubclass(cls, FiestaPlugin)
            and cls is not FiestaPlugin
            and cls.__module__ == module.__name__
        ]
        if len(classes) != 1:
            raise ValueError(f"{folder}/plugin.py must define exactly one FiestaPlugin subclass")
        plugin = classes[0]()
        if plugin.name != folder.name:
            raise ValueError(
                f"{folder}/plugin.py: plugin name {plugin.name!r} must match its folder"
            )
        plugins[plugin.name] = plugin
    tiles = [tile.cell for plugin in plugins.values() for tile in plugin.grid_tiles]
    if clash := sorted({c for c in tiles if c in CORE_GRID_CELLS or tiles.count(c) > 1}):
        raise ValueError(f"plugin grid tiles {clash} repeat a core or another plugin's tile")
    return plugins


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
    active = [plugins[name] for name in node.features.plugins]
    # The SPA serves every plugin's pages (inactive ones as not found), so a
    # content page may not take one on any node.
    taken = {slug: p.name for p in plugins.values() for slug in p.pages}
    if clash := sorted(page.slug for page in node.pages if page.slug in taken):
        owners = ", ".join(taken[slug] for slug in clash)
        raise ValueError(f"pages {clash} are plugin pages ({owners})")
    # A grid column names a core tile or one an active plugin adds.
    tiles = {tile.cell for p in active for tile in p.grid_tiles} | set(CORE_GRID_CELLS)
    for level in node.search.levels:
        if unknown := sorted({c.cell for c in level.columns or []} - tiles):
            offered = {tile.cell: p.name for p in plugins.values() for tile in p.grid_tiles}
            owners = [f"{c}: plugin {offered[c]!r}" for c in unknown if c in offered]
            raise ValueError(
                f"search level {level.name!r} grid names unknown tiles {unknown}"
                + (f" ({'; '.join(owners)}, not switched on)" if owners else "")
            )
    return active
