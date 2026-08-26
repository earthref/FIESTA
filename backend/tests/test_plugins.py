from fiesta.domain.parse import parse_text
from fiesta.plugins import active_plugins, all_plugins
from fiesta.plugins.plateau import identify_plateau, process_plateau_data
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
    assert [p.name for p in plugins] == ["poles"]
    # Poles is NOT a top-level tab...
    assert plugins[0].search_levels(magic_node) == []
    # ...but `poles` is a searchable table, surfaced as a Locations sub-tab.
    assert plugins[0].search_tables(magic_node) == ["poles"]
    cfg = plugins[0].frontend_config(magic_node)
    assert cfg["base_level"] == "Locations" and cfg["after_sub_tab"] == "Rows"


def _step(temp, ar40_39, ar36_39, ar39, s40=0.01, s36=0.0001):
    return {
        "measurement_step_heat_temperature": str(temp),
        "measurement_40ar_39ar_ratio": str(ar40_39),
        "measurement_40ar_39ar_ratio_sigma": str(s40),
        "total_36ar_39ar_ratio": str(ar36_39),
        "total_36ar_39ar_ratio_sigma": str(s36),
        "corrected_39ar_potassium": str(ar39),
        "experiment": "EXP-1",
    }


def test_deduplicates_identical_rows():
    rows = [_step(500, 10.0, 0.001, 1.0)] * 3
    assert process_plateau_data(rows)["unique_steps"] == 1


def test_plateau_flat_spectrum():
    # 6 near-identical consecutive steps -> the whole spectrum is one plateau.
    rows = [_step(500 + 100 * i, 10.0 + 0.001 * i, 0.001, 1.0) for i in range(6)]
    result = process_plateau_data(rows)
    assert result["unique_steps"] == 6
    assert len(result["age_data"]) == 6
    plateau = result["plateau"]
    assert plateau is not None
    assert len(plateau["plateau_steps"]) >= 3
    assert plateau["ar39_percent"] >= 50
    assert plateau["mswd"] <= 2.5
    # Age from the equation: (1/5.543e-10)*ln(1+1e-3*(10-295.5*0.001))/1e6 ≈ 17.4 Ma
    assert 15 < plateau["plateau_age"] < 20


def test_plateau_rejects_disturbed_spectrum():
    # Wildly varying ages with tiny sigmas -> no acceptable plateau.
    rows = [_step(500 + 100 * i, 5.0 + 8 * i, 0.001, 1.0, s40=0.001) for i in range(6)]
    result = process_plateau_data(rows)
    assert result["plateau"] is None or result["plateau"]["mswd"] <= 2.5


def test_identify_plateau_prefers_low_mswd():
    age_data = [
        {"age": 10.0, "age_sigma": 0.1, "cum_ar39": 20.0},
        {"age": 10.1, "age_sigma": 0.1, "cum_ar39": 40.0},
        {"age": 10.0, "age_sigma": 0.1, "cum_ar39": 60.0},
        {"age": 10.05, "age_sigma": 0.1, "cum_ar39": 80.0},
        {"age": 30.0, "age_sigma": 0.1, "cum_ar39": 100.0},
    ]
    plateau = identify_plateau(age_data)
    assert plateau is not None
    assert 4 not in plateau["plateau_steps"]  # the outlier step is excluded


def test_registry_names():
    assert set(all_plugins()) == {"poles", "depth-plot", "plateau-calculations"}
