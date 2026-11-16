"""The sample-tiles plugin: its summary grid tiles' defaults."""

from fiesta.plugins import all_plugins
from fiesta.search.grid import level_columns, sort_clauses


def test_default_tiles_sort_and_filter_on_their_columns(magic_node):
    sites = magic_node.search.levels[2]
    by_key = {c.key: c for c in level_columns(magic_node, sites)}
    # Listed tiles take the sidebar's facet lists instead of a text box.
    assert by_key["geology"].facets == ["geologic_classes", "geologic_types", "lithologies"]
    assert by_key["geology"].filter_fields == [] and by_key["method_codes"].facets
    assert by_key["geology"].sort.fields == ["summary._all.geologic_classes.raw"]
    # MagIC's ages are an interval (years BP whatever the unit): Age sorts
    # by its median.
    assert by_key["age"].facets == [] and by_key["age"].filter_fields == []
    assert by_key["age"].sort.fields == ["summary._interval.age.mid"]
    assert by_key["intensity"].width == 90 and not by_key["intensity"].filter_fields
    # Summary values are strings, so the numeric tiles sort by script.
    (script, _) = sort_clauses(by_key["intensity"], "desc")
    assert script["_script"]["type"] == "number"
    assert script["_script"]["script"]["params"]["fields"] == [
        "summary._all.int_abs.raw",
        "summary._all.intensities.raw",
    ]


def test_tiles_follow_the_options_and_activation(magic_node):
    # Without the node's interval, Age is its columns as contributed.
    options = {"age_columns": ["age"], "age_interval": "none"}
    node = magic_node.model_copy(
        update={"plugins": {**magic_node.plugins, "sample-tiles": options}}
    )
    sites = node.search.levels[2]
    age = {c.key: c for c in level_columns(node, sites)}["age"]
    assert age.filter_fields == ["summary._all.age"]
    assert age.sort.fields == ["summary._all.age.raw"]
    # Switched off, a level without columns shows only the core tiles (no
    # level may name the plugin's tiles then: magic.yaml's are cleared).
    features = magic_node.features.model_copy(update={"plugins": ["poles"]})
    levels = [lvl.model_copy(update={"columns": None}) for lvl in magic_node.search.levels]
    search = magic_node.search.model_copy(update={"levels": levels})
    off = magic_node.model_copy(update={"features": features, "search": search})
    keys = [c.key for c in level_columns(off, levels[2])]
    assert keys == ["record", "counts", "map", "plot", "geo", "citations"]


def test_age_type_column_by_level(magic_node, karar_node):
    # KArAr's specimen Age tile: its preferred age's method and interpretation.
    plugin = all_plugins()["sample-tiles"]
    config = plugin.frontend_config(karar_node)
    assert config["age_type_columns"] == {
        "specimens": ["age_calculation_method", "age_interpretation"]
    }
    assert config["age_has_interval"]
    # Its own age: the interval's value column, its own sigma order.
    assert config["age_value_column"] == "age"
    assert config["age_sigma_columns"][0] == "age_sigma_internal"
    magic = plugin.frontend_config(magic_node)
    assert magic["age_type_columns"] == {}
    # Without the option, the interval's sigma columns.
    assert magic["age_sigma_columns"] == list(magic_node.search.interval("age").interval.sigma)
