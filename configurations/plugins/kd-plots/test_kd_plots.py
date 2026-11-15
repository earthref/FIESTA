"""The kd-plots plugin: options, the KdD activation and the option checks."""

import pytest

from fiesta.plugins import active_plugins
from fiesta.plugins.kd_plots import KdPlotsOptions


def _with_options(node, options):
    return node.model_copy(update={"plugins": {**node.plugins, "kd-plots": options}})


def test_kdd_activates_kd_plots(kdd_node):
    plugins = {p.name: p for p in active_plugins(kdd_node)}
    assert "kd-plots" in plugins
    plugin = plugins["kd-plots"]
    assert plugin.options(kdd_node) == KdPlotsOptions()
    config = plugin.frontend_config(kdd_node)
    assert config["levels"] == ["Partition Coefficients"]
    assert config["kd_low"] == "kd_low"
    assert config["labels"]["minerals"] == "Minerals"


def test_options_are_checked_against_the_node(kdd_node):
    with pytest.raises(ValueError, match="Extra inputs"):
        active_plugins(_with_options(kdd_node, {"colour": "red"}))
    with pytest.raises(ValueError, match="'rocks' is not a data model table"):
        active_plugins(_with_options(kdd_node, {"table": "rocks"}))
    with pytest.raises(ValueError, match=r"\['phase'\] are not kds columns"):
        active_plugins(_with_options(kdd_node, {"pattern_columns": ["minerals", "phase"]}))
    with pytest.raises(ValueError, match="not search levels"):
        active_plugins(_with_options(kdd_node, {"levels": ["Elements"]}))
    with pytest.raises(ValueError, match="do not search the 'kds' table"):
        active_plugins(_with_options(kdd_node, {"levels": ["Contributions"]}))
