"""The pmag-plots plugin: the PmagPy ports, plot data and derived counts."""

import pytest

from fiesta.domain.parse import parse_text
from fiesta.plugins.pmag_plots import (
    PmagPlotsPlugin,
    _by_sequence,
    compute_plots,
    dogeo,
    fisher_mean,
)


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


NO_MEASUREMENTS_TEXT = """tab delimited\tcontribution
id\tversion\tdata_model_version
99\t1\t3.0
>>>>>>>>>>
tab delimited\tlocations
location\tlocation_type\tpole_lat\tpole_lon
WithPole\tOutcrop\t78.5\t260.0
"""


def test_pmag_plots_derived_doc_counts(magic_node):
    (doc,) = PmagPlotsPlugin().derive_docs(magic_node, parse_text(PMAG_TEXT), {"id": 7})
    assert doc["type"] == "pmag_plots"
    assert doc["summary"]["pmag_plots"]["arai"] == 1
    no_plots = parse_text(NO_MEASUREMENTS_TEXT)
    assert PmagPlotsPlugin().derive_docs(magic_node, no_plots, {"id": 99}) == []
