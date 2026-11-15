"""The geomag-series plugin: its options against the GEOMAGIA node and the
query refinements it derives on the Sites docs."""

import pytest

from fiesta.domain.parse import parse_text
from fiesta.domain.summarize import summarize
from fiesta.plugins import active_plugins, add_derived_values
from fiesta.plugins.geomag_series import GeomagSeriesPlugin
from fiesta.services.node_config import check_pages_and_filters

# The sites table, one row per tuple (cells tab-joined).
SITES = [
    (
        "site\tlat\tlon\tage\tage_min\tage_max\tba\tdecl\tincl",
        "pi_methods\tmd_checks\tcooling_rate_corrections\tnum_dir_specimens\tnum_dir_samples",
    ),
    (
        "U1\t45\t10\t1550\t50\t100\t43.5\t\t\tThellier and Thellier (1959)",
        "No measurement:Triaxe exeperimental mitigation\tNot specified\t12\t14",
    ),
    (
        "U2\t46\t11\t-500\t-1\t20\t\t350\t60\tMicrowave Walton (1977)",
        "Not specified\tNo measurement:Not specified\t\t3",
    ),
    ("U3\t47\t12\t\t10\t10\t0\t\t\tNo measurement", "\t\t\t"),
]
SITES_TEXT = (
    "tab delimited\tcontribution\nid\tversion\tdata_model_version\n7\t1\t1.0\n"
    ">>>>>>>>>>\ntab delimited\tsites\n" + "".join("\t".join(r) + "\n" for r in SITES)
)


def _plugin():
    return GeomagSeriesPlugin()


def test_geomagia_options_fit_its_node(geomagia_node):
    plugin = _plugin()
    options = plugin.options(geomagia_node)
    plugin.check(geomagia_node, options)
    assert "geomag-series" in [p.name for p in active_plugins(geomagia_node)]
    assert plugin.derived_columns(geomagia_node) == {
        "data_type": "text",
        "pi_family": "text",
        "md_check": "text",
        "cooling_rate_check": "text",
        "age_error": "number",
        "direction_n": "number",
    }
    config = plugin.frontend_config(geomagia_node)
    assert config["table"] == "sites" and config["color_by"] == "region_country"
    # The YAML's filters on the derived columns pass the node checks.
    assert check_pages_and_filters(geomagia_node, {}) == []


def test_derived_refinements_per_record(geomagia_node):
    plugin = _plugin()
    rows = {r["site"]: r for r in parse_text(SITES_TEXT).tables["sites"]}

    def derive(site):
        return plugin.derive_values(geomagia_node, "sites", [rows[site]])

    one = derive("U1")
    assert one["data_type"] == ["Intensity"]
    assert one["pi_family"] == ["Thellier Family"]
    # A check's name is Yes, even beside "No measurement"; only the check_none names are No.
    assert one["md_check"] == ["Yes"] and one["cooling_rate_check"] == ["No"]
    assert one["age_error"] == [100.0]
    assert one["direction_n"] == [14.0]

    two = derive("U2")
    assert two["data_type"] == ["Direction"]
    # Microwave Walton is in two families, as GEOMAGIA lists it.
    assert two["pi_family"] == ["Microwave", "Walton"]
    assert two["md_check"] == ["No"] and two["cooling_rate_check"] == ["No"]
    # A negative error is no error: no age_error.
    assert "age_error" not in two
    assert two["direction_n"] == [3.0]

    # No age, a zero intensity, no method: nothing but nothing.
    assert derive("U3") == {}
    # Another table's docs are left alone.
    assert plugin.derive_values(geomagia_node, "contribution", [rows["U1"]]) == {}


def test_derived_values_land_in_the_search_docs(geomagia_node):
    docs = summarize(geomagia_node, parse_text(SITES_TEXT), {"id": 7})
    add_derived_values(geomagia_node, docs)
    by_site = {d["summary"]["sites"]["site"]: d["summary"] for d in docs if d["type"] == "sites"}
    assert by_site["U1"]["_all"]["data_type"] == ["Intensity"]
    assert by_site["U1"]["_num"]["age_error"] == [100.0]
    assert by_site["U2"]["_all"]["pi_family"] == ["Microwave", "Walton"]
    contribution = next(d["summary"] for d in docs if d["type"] == "contribution")
    # The contribution doc answers its records' refinements too.
    assert contribution["_all"]["data_type"] == ["Direction", "Intensity"]
    assert contribution["_all"]["md_check"] == ["No", "Yes"]
    assert contribution["_num"]["direction_n"] == [3.0, 14.0]


def test_check_rejects_options_that_do_not_fit(geomagia_node):
    plugin = _plugin()
    bad = [
        {"base_level": "Specimens"},
        {"base_level": "Sites", "intensity": "site_name"},
        {"base_level": "Sites", "hover": ["no_such_column"]},
        {"base_level": "Sites", "pi_families": [{"name": "X", "methods": ["Shaw (1974)"]}]},
        {"base_level": "Sites", "color_by": "no_such_column"},
        # Names outside the column's vocabulary (a typo, or a code).
        {
            "base_level": "Sites",
            "pi_methods": "pi_methods",
            "pi_families": [{"name": "X", "methods": ["Shaw 1974"]}],
        },
        {"base_level": "Sites", "checks": {"md_check": "md_checks"}, "check_none": ["-1"]},
    ]
    for raw in bad:
        options = plugin.Options(**raw)
        with pytest.raises(ValueError, match="geomag-series"):
            plugin.check(geomagia_node, options)
    with pytest.raises(ValueError):
        plugin.Options(base_level="Sites", pi_families=[{"name": "X", "methods": []}])
