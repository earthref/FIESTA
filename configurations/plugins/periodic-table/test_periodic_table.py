"""The periodic-table plugin: options, the KdD activation and its facet column."""

import pytest
from fastapi import HTTPException

from fiesta.apps.routers.search import _facet_names
from fiesta.plugins import active_plugins
from fiesta.plugins.periodic_table import PeriodicTableOptions, PeriodicTablePlugin


def _with_options(node, options):
    return node.model_copy(update={"plugins": {**node.plugins, "periodic-table": options}})


def test_kdd_activates_the_periodic_table(kdd_node):
    plugins = {p.name: p for p in active_plugins(kdd_node)}
    assert "periodic-table" in plugins
    plugin = plugins["periodic-table"]
    options = plugin.options(kdd_node)
    assert options == PeriodicTableOptions(table="kds", column="element")
    config = plugin.frontend_config(kdd_node)
    assert config["column"] == "element" and config["levels"] == []
    assert config["label"] == "Periodic Table"


def test_options_are_checked_against_the_node(kdd_node):
    with pytest.raises(ValueError, match="Extra inputs"):
        active_plugins(_with_options(kdd_node, {"colour": "red"}))
    with pytest.raises(ValueError, match="'rocks' is not a data model table"):
        active_plugins(_with_options(kdd_node, {"table": "rocks"}))
    with pytest.raises(ValueError, match="'symbol' is not a kds column"):
        active_plugins(_with_options(kdd_node, {"column": "symbol"}))
    with pytest.raises(ValueError, match="not search levels"):
        active_plugins(_with_options(kdd_node, {"levels": ["Elements"]}))
    # A level the node has is fine.
    active_plugins(_with_options(kdd_node, {"levels": ["Partition Coefficients"]}))


def test_the_element_column_is_a_search_facet(kdd_node, magic_node):
    assert PeriodicTablePlugin().search_facets(kdd_node) == ["element"]
    # The search API counts it on any KdD level...
    assert _facet_names(kdd_node, "kds", False, ["element"]) == ["element"]
    assert _facet_names(kdd_node, "contribution", False, ["element"]) == ["element"]
    # ...and only where the plugin is active.
    with pytest.raises(HTTPException):
        _facet_names(magic_node, "sites", False, ["element"])
