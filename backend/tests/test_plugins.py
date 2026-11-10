"""The plugin registry and option validation (each plugin's own tests live in
its folder, config/plugins/<name>/test_<name>.py)."""

import pytest

from fiesta.plugins import active_plugins, all_plugins


def test_registry_names():
    assert set(all_plugins()) == {
        "poles",
        "rock-mag",
        "depth-plot",
        "plateau-calculations",
        "pmag-plots",
    }
    for plugin in all_plugins().values():
        assert plugin.description
        assert plugin.options_schema()["type"] == "object"


def test_plugin_options_come_from_the_node_yaml(magic_node, karar_node):
    plugins = all_plugins()
    # magic.yaml sets the poles options explicitly; they match the defaults.
    assert plugins["poles"].options(magic_node).base_level == "Locations"
    assert plugins["poles"].options(magic_node) == plugins["poles"].Options()
    assert plugins["poles"].frontend_config(magic_node)["age_color"]["selected"] == "#800080"
    assert plugins["plateau-calculations"].options(karar_node).max_mswd == 2.5

    # Options are validated: unknown keys, out-of-range values, and (via
    # check) tables, columns or levels the node does not have.
    def with_options(node, name, options):
        return node.model_copy(update={"plugins": {**node.plugins, name: options}})

    with pytest.raises(ValueError, match="poles.*Extra inputs"):
        plugins["poles"].options(with_options(magic_node, "poles", {"colour": "red"}))
    with pytest.raises(ValueError, match="max_mswd"):
        active_plugins(with_options(karar_node, "plateau-calculations", {"max_mswd": -1}))
    with pytest.raises(ValueError, match="not a search level"):
        active_plugins(with_options(magic_node, "poles", {"base_level": "Moons"}))
    # A MagIC-model plugin switched on for a node whose model lacks its tables
    # is refused with a ValueError, not a KeyError the admin UI would 500 on.
    with pytest.raises(ValueError, match="poles.*no \\['locations'\\] table"):
        active_plugins(with_options(karar_node, "poles", {"base_level": "Samples"}))
    with pytest.raises(ValueError, match="unknown plugins \\['nope'\\]"):
        active_plugins(with_options(magic_node, "nope", {}))
    # Options of a plugin that is not switched on are still checked.
    with pytest.raises(ValueError, match="not search levels"):
        active_plugins(with_options(magic_node, "depth-plot", {"levels": ["Cores"]}))
