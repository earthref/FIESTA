import pytest

from fiesta.domain.parse import parse_text
from fiesta.plugins import active_plugins, all_plugins
from fiesta.plugins.plateau import identify_plateau, process_plateau_data
from fiesta.plugins.pmag_plots import (
    PmagPlotsPlugin,
    _by_sequence,
    compute_plots,
    dogeo,
    fisher_mean,
)
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
    assert [p.name for p in plugins] == ["poles", "rock-mag", "pmag-plots"]
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


def test_rock_mag_results_of_a_specimen(magic_node):
    # A specimen's hysteresis and anisotropy rows are one point on every
    # plot; a second hysteresis result (another temperature) is its own.
    text = """tab delimited\tspecimens
specimen\tsample\thyst_mr_ms\taniso_v1\taniso_v2\taniso_v3
S1\tA\t0.3\t\t\t
S1\tA\t\t0.36:10:5\t0.33:100:0\t0.31:190:85
S1\tA\t0.2\t\t\t
S2\tA\t\t\t\t
"""
    docs = RockMagPlugin().derive_docs(magic_node, parse_text(text), {"id": 1})
    assert [d["summary"]["specimens"]["_n_results"] for d in docs] == [2, 1]
    first, second = (d["summary"]["rock_mag"] for d in docs)
    assert first["mr_ms"] == pytest.approx(0.3) and first["v1_dec"] == 10.0
    assert second == {"mr_ms": pytest.approx(0.2)}


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


def _table(name: str, rows: list[dict]) -> str:
    columns = list(dict.fromkeys(c for row in rows for c in row))
    lines = [f"tab delimited\t{name}", "\t".join(columns)]
    lines += ["\t".join(str(row.get(c, "")) for c in columns) for row in rows]
    return "\n".join(lines)


PI = "LP-PI-TRM:LP-PI-BT-IZZI"
PMAG_TEXT = "\n>>>>>>>>>>\n".join(
    [
        _table("contribution", [{"id": 7, "version": 1, "data_model_version": "3.0"}]),
        _table("locations", [{"location": "L"}]),
        _table(
            "sites",
            [
                {
                    "site": "A",
                    "location": "L",
                    "dir_dec": 10,
                    "dir_inc": 40,
                    "dir_tilt_correction": 0,
                },
                {
                    "site": "B",
                    "location": "L",
                    "dir_dec": 20,
                    "dir_inc": 50,
                    "dir_tilt_correction": 0,
                },
            ],
        ),
        _table(
            "samples",
            [
                {
                    "sample": "D",
                    "site": "A",
                    "azimuth": 90,
                    "dip": 0,
                    "bed_dip_direction": 90,
                    "bed_dip": 0,
                },
                {"sample": "S", "site": "B"},
            ],
        ),
        _table(
            "specimens",
            [
                {"specimen": "D1", "sample": "D"},
                {
                    "specimen": "S1",
                    "sample": "S",
                    "int_abs": 6e-05,
                    "meas_step_min": 373,
                    "meas_step_max": 473,
                    "meas_step_unit": "K",
                },
            ],
        ),
        _table(
            "measurements",
            [
                # AF demagnetization, in specimen coordinates.
                {
                    "specimen": "D1",
                    "method_codes": "LT-NO:LP-DIR-AF",
                    "sequence": 1,
                    "treat_temp": 273,
                    "dir_dec": 0,
                    "dir_inc": 30,
                    "magn_moment": 1.0,
                },
                {
                    "specimen": "D1",
                    "method_codes": "LT-AF-Z:LP-DIR-AF",
                    "sequence": 2,
                    "treat_ac_field": 0.01,
                    "dir_dec": 0,
                    "dir_inc": 30,
                    "magn_moment": 0.5,
                },
                {
                    "specimen": "D1",
                    "method_codes": "LT-AF-Z:LP-DIR-AF",
                    "sequence": 3,
                    "treat_ac_field": 0.02,
                    "dir_dec": 0,
                    "dir_inc": 30,
                    "magn_moment": 0.25,
                    "quality": "b",
                },
                # IZZI Thellier: NRM (0, 0, 1); 100 °C ZI; 200 °C IZ; a pTRM check at 100 °C.
                {
                    "specimen": "S1",
                    "method_codes": f"LT-NO:{PI}",
                    "sequence": 4,
                    "treat_temp": 273,
                    "dir_dec": 0,
                    "dir_inc": 90,
                    "magn_moment": 1.0,
                },
                {
                    "specimen": "S1",
                    "method_codes": f"LT-T-Z:{PI}",
                    "sequence": 5,
                    "treat_temp": 373,
                    "dir_dec": 0,
                    "dir_inc": 90,
                    "magn_moment": 0.8,
                },
                {
                    "specimen": "S1",
                    "method_codes": f"LT-T-I:{PI}",
                    "sequence": 6,
                    "treat_temp": 373,
                    "treat_dc_field": 4e-05,
                    "dir_dec": 0,
                    "dir_inc": 82.8750,
                    "magn_moment": 0.806226,
                },
                {
                    "specimen": "S1",
                    "method_codes": f"LT-T-I:{PI}",
                    "sequence": 7,
                    "treat_temp": 473,
                    "treat_dc_field": 4e-05,
                    "dir_dec": 0,
                    "dir_inc": 59.0362,
                    "magn_moment": 0.583095,
                },
                {
                    "specimen": "S1",
                    "method_codes": f"LT-T-Z:{PI}",
                    "sequence": 8,
                    "treat_temp": 473,
                    "dir_dec": 0,
                    "dir_inc": 90,
                    "magn_moment": 0.5,
                },
                {
                    "specimen": "S1",
                    "method_codes": f"LT-PTRM-I:{PI}",
                    "sequence": 9,
                    "treat_temp": 373,
                    "dir_dec": 0,
                    "dir_inc": 78.6901,
                    "magn_moment": 0.509902,
                },
                # Anisotropy steps reuse LT-T-I and stay out of the Arai plot.
                {
                    "specimen": "S1",
                    "method_codes": "LT-T-I:LP-AN-TRM",
                    "sequence": 10,
                    "treat_temp": 473,
                    "dir_dec": 90,
                    "dir_inc": 0,
                    "magn_moment": 9.0,
                },
            ]
            + [
                # Listed from -1 T up, measured (`sequence`) from +1 T down.
                {
                    "specimen": "D1",
                    "experiment": "D1-HYS",
                    "method_codes": "LP-HYS",
                    "sequence": 100 - f,
                    "meas_field_dc": f / 10,
                    "magn_mass": f / 20,
                }
                for f in range(-10, 11)
            ],
        ),
    ]
)


def test_pmag_plots_ports_match_pmagpy():
    # With the sample's X axis pointing east and level, specimen north is east.
    dec, inc = dogeo(0, 30, 90, 0)
    assert (dec, inc) == (pytest.approx(90), pytest.approx(30))
    mean = fisher_mean([(10, 40), (20, 50)])
    assert mean is not None and mean["n"] == 2 and 10 < mean["dec"] < 20
    assert fisher_mean([(10, 40)]) is None


def test_pmag_plots_counts_and_data():
    plots = compute_plots(parse_text(PMAG_TEXT))
    assert plots["counts"] == {
        "eqarea": 3,  # the sites of L, and both specimens' demagnetization steps
        "zijd": 2,
        "demag": 2,
        "arai": 1,
        "deremag": 1,
        "hyst": 1,
    }

    demag = {s["specimen"]: s for s in plots["demag"]["specimens"]}
    d1 = demag["D1"]
    assert (d1["site"], d1["location"]) == ("A", "L")
    assert d1["steps"]["kind"] == ["NRM", "AF", "AF"]
    assert d1["steps"]["value"] == [0.0, 10.0, 20.0]
    assert d1["steps"]["bad"] == [0, 0, 1]
    assert d1["geo"]["dec"] == [90.0, 90.0, 90.0]
    assert d1["tilt"]["dec"] == [90.0, 90.0, 90.0]
    # A Thellier specimen's zero-field steps are its demagnetization.
    assert demag["S1"]["steps"]["value"] == [0.0, 100.0, 200.0]
    assert "geo" not in demag["S1"]

    (sites,) = plots["eqarea"]["plots"]
    assert (sites["level"], sites["name"]) == ("Sites", "L")
    assert [d["name"] for d in sites["sets"]["g"]["dirs"]] == ["A", "B"]
    assert sites["sets"]["g"]["mean"]["n"] == 2

    (arai,) = plots["arai"]["specimens"]
    assert arai["lab_field"] == 40.0
    assert arai["steps"]["t"] == [0.0, 100.0, 200.0]
    assert arai["steps"]["order"] == ["NRM", "ZI", "IZ"]
    assert arai["steps"]["x"] == pytest.approx([0, 0.1, 0.3], abs=1e-3)
    assert arai["steps"]["y"] == pytest.approx([1, 0.8, 0.5], abs=1e-3)
    checks = arai["ptrm_checks"]
    assert (checks["t"], checks["t_from"]) == ([100.0], [200.0])
    assert checks["x"] == pytest.approx([0.1], abs=1e-3)
    assert checks["y"] == pytest.approx([0.5], abs=1e-3)
    fit = arai["fit"]
    assert fit["b"] == pytest.approx(-1.5, abs=1e-2)
    assert fit["int_calc"] == pytest.approx(60, abs=0.5)
    assert fit["int_abs"] == 60.0

    (loop,) = plots["hyst"]["loops"]
    assert loop["unit"] == "Am²/kg"
    assert loop["field"][0] == 1000.0 and loop["field"][-1] == -1000.0 and len(loop["m"]) == 21


def test_pmag_plots_sequence_order_repairs_lost_zeros():
    def order(*sequence):
        rows = [{"sequence": str(s), "i": i} for i, s in enumerate(sequence)]
        return [r["i"] for r in _by_sequence(rows)]

    # 9010 saved as 901 (and 15000 as 15) stays between its neighbours.
    assert order(9008, 9009, 901, 9011, 14999, 15, 15001) == [0, 1, 2, 3, 4, 5, 6]
    # A loop's first number repaired from the one after it.
    assert order(1, 11, 12) == [0, 1, 2]
    # Clean numbers out of file order are sorted.
    assert order(3, 1, 2) == [1, 2, 0]
    # Without a sequence on every row, file order.
    assert [r["i"] for r in _by_sequence([{"sequence": "2", "i": 0}, {"i": 1}])] == [0, 1]


def test_pmag_plots_derived_doc_counts(magic_node):
    (doc,) = PmagPlotsPlugin().derive_docs(magic_node, parse_text(PMAG_TEXT), {"id": 7})
    assert doc["type"] == "pmag_plots"
    assert doc["summary"]["pmag_plots"]["arai"] == 1
    assert PmagPlotsPlugin().derive_docs(magic_node, parse_text(POLE_TEXT), {"id": 99}) == []
