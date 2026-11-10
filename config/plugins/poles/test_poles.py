"""The poles plugin: derived pole docs and the Locations sub-tab."""

from fiesta.domain.parse import parse_text
from fiesta.plugins import active_plugins
from fiesta.plugins.poles import PolesPlugin

POLE_TEXT = """tab delimited\tcontribution
id\tversion\tdata_model_version
99\t1\t3.0
>>>>>>>>>>
tab delimited\tlocations
location\tlocation_type\tpole_lat\tpole_lon\talpha95\tgeologic_classes
NoPole\tOutcrop\t\t\t\tIgneous
WithPole\tOutcrop\t78.5\t260.0\t3.2\tIgneous
"""


def test_poles_derive_docs(magic_node):
    docs = PolesPlugin().derive_docs(magic_node, parse_text(POLE_TEXT), {"id": 99})
    assert len(docs) == 1
    doc = docs[0]
    assert doc["type"] == "poles"
    assert doc["summary"]["locations"]["pole_lat"] == "78.5"
    # 260°E normalizes to -100 for the OpenSearch geo_point
    assert doc["summary"]["_all"]["_geo_point"] == {"lat": 78.5, "lon": -100.0}
    assert doc["summary"]["_all"]["geologic_classes"] == ["Igneous"]


def test_poles_is_searchable_table_not_top_level(magic_node):
    plugins = active_plugins(magic_node)
    assert [p.name for p in plugins] == ["poles", "rock-mag", "pmag-plots"]
    # Poles is NOT a top-level tab...
    assert plugins[0].search_levels(magic_node) == []
    # ...but `poles` is a searchable table, surfaced as a Locations sub-tab.
    assert plugins[0].search_tables(magic_node) == ["poles"]
    cfg = plugins[0].frontend_config(magic_node)
    assert cfg["base_level"] == "Locations" and cfg["after_sub_tab"] == "Rows"
