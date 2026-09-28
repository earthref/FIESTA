import pytest

from fiesta.domain.parse import parse_text
from fiesta.plugins import active_plugins, all_plugins
from fiesta.plugins.plateau import identify_plateau, process_plateau_data
from fiesta.plugins.poles import PolesPlugin
from fiesta.plugins.rock_mag import (
    RockMagPlugin,
    field_units,
    rock_mag_values,
    symmetric_eigenvalues,
)

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
    assert [p.name for p in plugins] == ["poles", "rock-mag"]
    # Poles is NOT a top-level tab...
    assert plugins[0].search_levels(magic_node) == []
    # ...but `poles` is a searchable table, surfaced as a Locations sub-tab.
    assert plugins[0].search_tables(magic_node) == ["poles"]
    cfg = plugins[0].frontend_config(magic_node)
    assert cfg["base_level"] == "Locations" and cfg["after_sub_tab"] == "Rows"


ROCK_MAG_TEXT = """tab delimited\tcontribution
id\tversion\tdata_model_version
99\t1\t3.0
>>>>>>>>>>
tab delimited\tsites
site\tlocation\tlat\tlon\tlithologies
S1\tL1\t32.5\t243.0\tBasalt
>>>>>>>>>>
tab delimited\tsamples
sample\tsite\tlithologies
S1a\tS1\t
>>>>>>>>>>
tab delimited\tspecimens
specimen\tsample\thyst_mr_mass\thyst_ms_mass\thyst_bc\thyst_bcr\tcritical_temp\taniso_v1\taniso_v2\taniso_v3
S1a1\tS1a\t0.2\t1.0\t0.01\t0.025\t853.15\t0.36:10:5:e\t0.33:100:0:e\t0.31:190:85:e
S1a2\tS1a\t\t\t\t\t\t\t\t
"""


def test_rock_mag_derive_docs(magic_node):
    docs = RockMagPlugin().derive_docs(magic_node, parse_text(ROCK_MAG_TEXT), {"id": 99})
    # Only the specimen with rock-magnetic data becomes a doc.
    assert [d["summary"]["specimens"]["specimen"] for d in docs] == ["S1a1"]
    values = docs[0]["summary"]["rock_mag"]
    assert values["mr_ms"] == pytest.approx(0.2)
    assert values["bc"] == pytest.approx(10) and values["bcr"] == pytest.approx(25)
    assert values["bcr_bc"] == pytest.approx(2.5)
    assert values["tc"] == pytest.approx(580)
    assert values["p"] == pytest.approx(0.36 / 0.31)
    assert (values["v1_dec"], values["v3_inc"]) == (10.0, 85.0)
    assert all(isinstance(v, float) for v in values.values())
    # Position and facets come from the site, through the sample.
    assert docs[0]["summary"]["_all"]["_geo_point"] == {"lat": 32.5, "lon": -117.0}
    assert docs[0]["summary"]["_all"]["lithologies"] == ["Basalt"]


def test_rock_mag_fields_recorded_in_millitesla():
    # A contribution whose coercivities' median is above 1 T recorded them in
    # mT; one in tesla (the data model's unit) is scaled to mT.
    in_mt = [{"hyst_bc": "12.5", "hyst_bcr": "30"}, {"hyst_bc": "8", "hyst_bcr": "25"}]
    units = field_units(in_mt)
    assert (units["hyst_bc"], units["hyst_bcr"]) == (1.0, 1.0)
    assert rock_mag_values(in_mt[0], units)["bc"] == pytest.approx(12.5)
    in_t = [{"hyst_bc": "0.0125", "rem_mdf": "0.02"}]
    values = rock_mag_values(in_t[0], field_units(in_t))
    assert (values["bc"], values["mdf"]) == (pytest.approx(12.5), pytest.approx(20))


def test_rock_mag_values_from_the_tensor():
    # A prolate tensor (k1 > k2 = k3): T is -1, and no axes without v1..v3.
    values = rock_mag_values({"aniso_s": "0.36:0.32:0.32:0:0:0"})
    assert values["t"] == pytest.approx(-1)
    assert values["pj"] > values["p"] > 1
    assert "v1_dec" not in values
    specimen_axes = {"aniso_v1": "0.4:10:5", "aniso_v2": "0.3:100:0", "aniso_v3": "0.3:190:85"}
    assert "v1_dec" not in rock_mag_values({**specimen_axes, "aniso_tilt_correction": "-1"})
    assert "v1_dec" in rock_mag_values({**specimen_axes, "aniso_tilt_correction": "0"})
    assert symmetric_eigenvalues([2, 2, 3, 1, 0, 0]) == pytest.approx([3, 3, 1])
    # Non-physical ratios are left out.
    assert rock_mag_values({"hyst_mr_ms": "1.4", "hyst_bc": "-0.01"}) == {}


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
    assert set(all_plugins()) == {
        "poles",
        "rock-mag",
        "depth-plot",
        "plateau-calculations",
        "record-cards",
    }
    for plugin in all_plugins().values():
        assert plugin.description
        assert plugin.options_schema()["type"] == "object"


def test_plugin_options_come_from_the_node_yaml(magic_node, erda_node, karar_node):
    plugins = all_plugins()
    # magic.yaml sets the poles options explicitly; they match the defaults.
    assert plugins["poles"].options(magic_node).base_level == "Locations"
    assert plugins["poles"].options(magic_node) == plugins["poles"].Options()
    assert plugins["poles"].frontend_config(magic_node)["age_color"]["selected"] == "#800080"
    # record cards are erda.yaml, not a dict keyed by node name in Python.
    cards = plugins["record-cards"].options(erda_node).cards
    assert set(cards) == {"objects", "files"} and cards["files"].cells[2].format == "bytes"
    assert plugins["plateau-calculations"].options(karar_node).max_mswd == 2.5

    # Options are validated: unknown keys, out-of-range values, and (via
    # check) tables, columns or levels the node does not have.
    def with_options(node, name, options):
        return node.model_copy(update={"plugins": {**node.plugins, name: options}})

    with pytest.raises(ValueError, match="poles.*Extra inputs"):
        plugins["poles"].options(with_options(magic_node, "poles", {"colour": "red"}))
    with pytest.raises(ValueError, match="max_mswd"):
        active_plugins(with_options(karar_node, "plateau-calculations", {"max_mswd": -1}))
    with pytest.raises(ValueError, match="no tables \\['ships'\\]"):
        active_plugins(
            with_options(erda_node, "record-cards", {"cards": {"ships": {"title_column": "x"}}})
        )
    with pytest.raises(ValueError, match="not a search level"):
        active_plugins(with_options(magic_node, "poles", {"base_level": "Moons"}))
    with pytest.raises(ValueError, match="unknown plugins \\['nope'\\]"):
        active_plugins(with_options(magic_node, "nope", {}))
    # Options of a plugin that is not switched on are still checked.
    with pytest.raises(ValueError, match="not search levels"):
        active_plugins(with_options(magic_node, "depth-plot", {"levels": ["Cores"]}))
