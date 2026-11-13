"""The plugin registry and option validation (each plugin's own tests live in
its folder, configurations/plugins/<name>/test_<name>.py)."""

import pytest

from fiesta.plugins import active_plugins, all_plugins


def test_registry_names():
    assert set(all_plugins()) == {
        "poles",
        "rock-mag",
        "depth-plot",
        "plateau-calculations",
        "pmag-plots",
        "periodic-table",
        "method-codes",
        "sample-tiles",
    }
    for plugin in all_plugins().values():
        assert plugin.description
        assert plugin.options_schema()["type"] == "object"


def test_plugin_pages_and_grid_tiles_are_checked(magic_node, sc_node):
    from fiesta.nodeconfig import GridColumn, PageConfig

    # A content page may not take a plugin's page slug, on any node.
    pages = [*sc_node.pages, PageConfig(slug="method-codes", title="Codes")]
    with pytest.raises(ValueError, match=r"pages \['method-codes'\] are plugin pages"):
        active_plugins(sc_node.model_copy(update={"pages": pages}))
    # A grid column names a core tile or one an active plugin adds.
    level = magic_node.search.levels[2].model_copy(
        update={"columns": [GridColumn(cell="geo"), GridColumn(cell="intensity")]}
    )
    # (The other levels on their default tiles, whatever magic.yaml configures.)
    levels = [lvl.model_copy(update={"columns": None}) for lvl in magic_node.search.levels]
    levels[2] = level
    search = magic_node.search.model_copy(update={"levels": levels})
    active_plugins(magic_node.model_copy(update={"search": search}))
    features = magic_node.features.model_copy(update={"plugins": ["poles"]})
    off = magic_node.model_copy(update={"search": search, "features": features})
    with pytest.raises(ValueError, match="unknown tiles \\['intensity'\\].*'sample-tiles'"):
        active_plugins(off)
    levels[2] = level.model_copy(update={"columns": [GridColumn(cell="nope")]})
    search = magic_node.search.model_copy(update={"levels": levels})
    with pytest.raises(ValueError, match="unknown tiles \\['nope'\\]"):
        active_plugins(magic_node.model_copy(update={"search": search}))


def test_plugin_options_come_from_the_node_yaml(magic_node, karar_node):
    plugins = all_plugins()
    # magic.yaml sets the poles options explicitly; they match the defaults.
    assert plugins["poles"].options(magic_node).base_level == "Locations"
    assert plugins["poles"].options(magic_node) == plugins["poles"].Options()
    assert plugins["poles"].frontend_config(magic_node)["age_color"]["selected"] == "#800080"
    assert plugins["plateau-calculations"].options(karar_node).specimen_levels == ["Specimens"]

    # Options are validated: unknown keys, out-of-range values, and (via
    # check) tables, columns or levels the node does not have.
    def with_options(node, name, options):
        return node.model_copy(update={"plugins": {**node.plugins, name: options}})

    with pytest.raises(ValueError, match="poles.*Extra inputs"):
        plugins["poles"].options(with_options(magic_node, "poles", {"colour": "red"}))
    with pytest.raises(ValueError, match="plateau-calculations.*not search levels"):
        active_plugins(
            with_options(karar_node, "plateau-calculations", {"specimen_levels": ["Moons"]})
        )
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
