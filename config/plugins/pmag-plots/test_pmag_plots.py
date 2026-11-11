"""The pmag-plots plugin: PmagPy's science in the plot data, the payload's
geometry, the row cleaning that keeps PmagPy from raising, and the counts."""

import asyncio
import gzip
import json

import pytest
from pmagpy import pmag

from fiesta.domain.parse import parse_text
from fiesta.plugins.pmag_plots import (
    KINDS,
    PmagPlotsPlugin,
    _by_sequence,
    _circle,
    _PlotIndex,
    _Plots,
    _xy,
    arai_specimen,
    compute_counts,
    compute_plots,
    compute_thumbnails,
    fisher_mean,
    net,
)


def _table(name: str, rows: list[dict]) -> str:
    columns = list(dict.fromkeys(c for row in rows for c in row))
    lines = [f"tab delimited\t{name}", "\t".join(columns)]
    lines += ["\t".join(str(row.get(c, "")) for c in columns) for row in rows]
    return "\n".join(lines)


PI = "LP-PI-TRM:LP-PI-BT-IZZI"
THELLIER = [
    # IZZI Thellier: NRM (0, 0, 1) and pTRM gained along north, on one line of
    # slope -1.5 — 100 °C ZI, 200 °C IZ, 300 °C ZI; a pTRM check at 100 °C
    # after the 200 °C step, a tail check at 100 °C.
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
        "method_codes": f"LT-T-Z:{PI}:LP-PI-TRM-ZI",
        "sequence": 5,
        "treat_temp": 373,
        "dir_dec": 0,
        "dir_inc": 90,
        "magn_moment": 0.8,
    },
    {
        "specimen": "S1",
        "method_codes": f"LT-T-I:{PI}:LP-PI-TRM-ZI",
        "sequence": 6,
        "treat_temp": 373,
        "treat_dc_field": 4e-05,
        "dir_dec": 0,
        "dir_inc": 82.8750,
        "magn_moment": 0.806226,
    },
    {
        "specimen": "S1",
        "method_codes": f"LT-T-I:{PI}:LP-PI-TRM-IZ",
        "sequence": 7,
        "treat_temp": 473,
        "treat_dc_field": 4e-05,
        "dir_dec": 0,
        "dir_inc": 59.0362,
        "magn_moment": 0.583095,
    },
    {
        "specimen": "S1",
        "method_codes": f"LT-T-Z:{PI}:LP-PI-TRM-IZ",
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
    {
        "specimen": "S1",
        "method_codes": f"LT-T-Z:{PI}:LP-PI-TRM-ZI",
        "sequence": 10,
        "treat_temp": 573,
        "dir_dec": 0,
        "dir_inc": 90,
        "magn_moment": 0.2,
    },
    {
        "specimen": "S1",
        "method_codes": f"LT-T-I:{PI}:LP-PI-TRM-ZI",
        "sequence": 11,
        "treat_temp": 573,
        "treat_dc_field": 4e-05,
        "dir_dec": 0,
        "dir_inc": 21.8014,
        "magn_moment": 0.538516,
    },
    {
        "specimen": "S1",
        "method_codes": f"LT-PTRM-MD:{PI}",
        "sequence": 12,
        "treat_temp": 373,
        "dir_dec": 0,
        "dir_inc": 90,
        "magn_moment": 0.82,
    },
    # Malformed legacy rows PmagPy would raise on or misread: a blank
    # temperature and direction, a tail check with no zero-field step.
    {"specimen": "S1", "method_codes": f"LT-T-I:{PI}", "sequence": 13, "magn_moment": 0.3},
    {
        "specimen": "S1",
        "method_codes": f"LT-PTRM-MD:{PI}",
        "sequence": 14,
        "treat_temp": 673,
        "dir_dec": 0,
        "dir_inc": 90,
        "magn_moment": 0.1,
    },
    # Anisotropy steps reuse LT-T-I and stay out of the Arai plot.
    {
        "specimen": "S1",
        "method_codes": "LT-T-I:LP-AN-TRM",
        "sequence": 15,
        "treat_temp": 473,
        "dir_dec": 90,
        "dir_inc": 0,
        "magn_moment": 9.0,
    },
]
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
                # A best-fit line over the NRM to 20 mT, and a vertical E–W plane.
                {
                    "specimen": "D1",
                    "sample": "D",
                    "method_codes": "DE-BFL",
                    "dir_dec": 0,
                    "dir_inc": 30,
                    "dir_tilt_correction": -1,
                    "meas_step_min": 0,
                    "meas_step_max": 0.02,
                    "meas_step_unit": "T",
                },
                {
                    "specimen": "D1",
                    "sample": "D",
                    "method_codes": "DE-BFP",
                    "dir_dec": 0,
                    "dir_inc": 0,
                    "dir_tilt_correction": -1,
                },
                {
                    "specimen": "S1",
                    "sample": "S",
                    "int_abs": 6e-05,
                    "meas_step_min": 373,
                    "meas_step_max": 573,
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
                # Without a moment, and without a field: left out.
                {
                    "specimen": "D1",
                    "method_codes": "LT-AF-Z:LP-DIR-AF",
                    "treat_ac_field": 0.03,
                    "dir_dec": 0,
                    "dir_inc": 30,
                },
                {
                    "specimen": "D1",
                    "method_codes": "LT-AF-Z:LP-DIR-AF",
                    "dir_dec": 0,
                    "dir_inc": 30,
                    "magn_moment": 0.1,
                },
            ]
            + THELLIER
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


def test_pmag_plots_geometry_is_pmagpy():
    # pmag.dimap: north up, east right, radius 1 on the horizontal; the
    # vertical, up or down, at the centre.
    assert _xy([0, 90, 180], [0, 0, 0]) == [[0, 1], [1, 0], [0, -1]]
    assert _xy([0, 0], [90, -90]) == [[0, 0], [0, 0]]
    (x, y), *_ = _xy([45], [30])
    assert (x, y) == pytest.approx(pmag.dimap(45, 30), abs=1e-3)

    mean = fisher_mean([(10, 40), (20, 50)])
    expected = pmag.fisher_mean([[10, 40], [20, 50]])
    assert mean is not None and mean["n"] == 2
    assert (mean["dec"], mean["inc"], mean["a95"]) == pytest.approx(
        (expected["dec"], expected["inc"], expected["alpha95"]), abs=0.01
    )
    assert fisher_mean([(10, 40)]) is None

    # A vertical east–west plane: half lower hemisphere, half upper, joined.
    runs = _circle(0, 0, 90)
    assert sorted(run["lower"] for run in runs) == [False, True]
    assert runs[0]["points"][-1] == runs[1]["points"][0]
    assert all(x * x + y * y <= 1.0001 for run in runs for x, y in run["points"])

    grid = net()
    assert len(grid["rim"]) == 361 and grid["rim"][0] == [0, 1]
    # 36 rim ticks, and a cross (two strokes) every 10° on the four axes.
    assert len(grid["ticks"]) == 36 + 2 * (9 + 3 * 8)


def test_pmag_plots_counts_and_data():
    parsed = parse_text(PMAG_TEXT)
    plots = compute_plots(parsed)
    assert plots["counts"] == {
        "eqarea": 4,  # the sites of L, D1's interpretations, both specimens' steps
        "zijd": 2,
        "demag": 2,
        "arai": 1,
        "deremag": 1,
        "hyst": 1,
    }
    assert compute_counts(parsed) == plots["counts"]

    demag = {s["specimen"]: s for s in plots["demag"]["specimens"]}
    assert plots["demag"]["net"] is net()
    d1 = demag["D1"]
    assert (d1["site"], d1["location"]) == ("A", "L")
    assert d1["steps"]["kind"] == ["NRM", "AF", "AF"]
    assert d1["steps"]["value"] == [0.0, 10.0, 20.0]
    assert d1["steps"]["bad"] == [0, 0, 1]
    specimen = d1["coords"]["s"]
    assert specimen["x"] == [0, 0, 0] and specimen["y"] == pytest.approx([0.707] * 3, abs=1e-3)
    # North, east, down over the NRM (pmagplotlib.plot_zij).
    assert (specimen["n"][0], specimen["e"][0], specimen["d"][0]) == pytest.approx(
        (0.866, 0, 0.5), abs=1e-3
    )
    assert specimen["n"][1] == pytest.approx(0.433, abs=1e-3)
    # The sample's X axis points east and level: specimen north is east.
    assert d1["coords"]["g"]["dec"] == [90.0, 90.0, 90.0]
    assert d1["coords"]["g"]["x"] == pytest.approx([0.707] * 3, abs=1e-3)
    assert d1["coords"]["t"]["dec"] == [90.0, 90.0, 90.0]
    line, plane = d1["fits"]
    assert line["xy"] == pytest.approx([0, 0.707], abs=1e-3)
    # Through the NRM and 10 mT steps (20 mT is flagged bad), along 0°/30°.
    (n0, e0, d0), (n1, e1, d1_) = line["zijd"]
    assert e0 == e1 == 0 and (d1_ - d0) / (n1 - n0) == pytest.approx(0.577, abs=1e-3)
    assert len(plane["circle"]) == 2 and "zijd" not in plane
    # A Thellier specimen's zero-field steps are its demagnetization.
    assert demag["S1"]["steps"]["value"] == [0.0, 100.0, 200.0, 300.0]
    assert set(demag["S1"]["coords"]) == {"s"}

    sites, d1_dirs = plots["eqarea"]["plots"][:2]
    assert (sites["level"], sites["name"]) == ("Sites", "L")
    assert [d["name"] for d in sites["sets"]["g"]["dirs"]] == ["A", "B"]
    mean = sites["sets"]["g"]["mean"]
    assert mean["n"] == 2 and len(mean["xy"]) == 2
    assert mean["circle"] and all(run["lower"] for run in mean["circle"])
    assert (d1_dirs["level"], d1_dirs["name"]) == ("Specimens", "A")
    line_dir, plane_dir = d1_dirs["sets"]["s"]["dirs"]
    assert "xy" in line_dir and plane_dir["plane"] and plane_dir["circle"]

    (arai,) = plots["arai"]["specimens"]
    assert arai["lab_field"] == 40.0
    assert arai["steps"]["t"] == [0.0, 100.0, 200.0, 300.0]
    assert arai["steps"]["order"] == ["NRM", "ZI", "IZ", "ZI"]
    assert arai["steps"]["x"] == pytest.approx([0, 0.1, 0.3, 0.5], abs=1e-3)
    assert arai["steps"]["y"] == pytest.approx([1, 0.8, 0.5, 0.2], abs=1e-3)
    checks = arai["ptrm_checks"]
    # The check against the record before it (200 °C), at the NRM remaining
    # of its own temperature (pmagplotlib.plot_arai).
    assert (checks["t"], checks["t_from"]) == ([100.0], [200.0])
    assert checks["x"] == pytest.approx([0.1], abs=1e-3)
    assert checks["y"] == pytest.approx([0.8], abs=1e-3)
    # |tail| − |zero-field| at the pTRM gained of its temperature.
    tails = arai["tail_checks"]
    assert tails["t"] == [100.0]
    assert (tails["x"], tails["y"]) == (pytest.approx([0.1], abs=1e-3), [0.02])
    fit = arai["fit"]
    assert fit["n"] == 3
    assert fit["b"] == pytest.approx(-1.5, abs=1e-3)
    assert fit["b_sigma"] == pytest.approx(0, abs=1e-3)
    assert fit["int_calc"] == pytest.approx(60, abs=0.5)
    assert fit["int_abs"] == 60.0
    (x0, y0), (x1, y1) = fit["line"]
    assert x0 < 0.1 < 0.5 < x1 and (y1 - y0) / (x1 - x0) == pytest.approx(-1.5, abs=1e-3)

    (loop,) = plots["hyst"]["loops"]
    assert loop["unit"] == "Am²/kg"
    assert loop["field"][0] == 1000.0 and loop["field"][-1] == -1000.0 and len(loop["m"]) == 21


def test_pmag_plots_arai_needs_three_steps_for_a_slope_and_survives_bad_rows():
    def measurements(rows: list[dict]) -> list[dict]:
        return parse_text(_table("measurements", rows)).tables["measurements"]

    rows = measurements([r for r in THELLIER if r.get("treat_temp") != 573])
    interpretation = {
        "int_abs": "6e-05",
        "meas_step_min": "373",
        "meas_step_max": "473",
        "meas_step_unit": "K",
    }
    item = arai_specimen(rows, interpretation)
    assert item is not None and item["steps"]["t"] == [0.0, 100.0, 200.0]
    # pmag.int_pars fits three steps or more.
    assert "b" not in item["fit"] and item["fit"]["int_abs"] == 60.0
    junk = [
        {"specimen": "S9", "method_codes": f"LT-NO:{PI}", "magn_moment": "1"},
        {"specimen": "S9", "method_codes": f"LT-T-I:{PI}", "treat_temp": "x", "dir_dec": "0"},
    ]
    assert arai_specimen(measurements(junk), None) is None
    # A blank NRM temperature is room temperature, as PmagPy assumes.
    blank_nrm = [{**r, "treat_temp": ""} if r["sequence"] == 4 else r for r in THELLIER]
    item = arai_specimen(measurements(blank_nrm), None)
    assert item is not None and item["steps"]["t"] == [0.0, 100.0, 200.0, 300.0]


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
    thumbnails = doc["summary"]["pmag_plots"]["_geometry"]["thumbnails"]
    assert sorted(thumbnails) == ["arai", "eqarea", "hyst", "zijd"]
    no_plots = parse_text(NO_MEASUREMENTS_TEXT)
    assert PmagPlotsPlugin().derive_docs(magic_node, no_plots, {"id": 99}) == []


def test_pmag_plots_record_thumbnails():
    # Each search record's Plot tile: the plots of the specimens below it and
    # its equal-area groups (a location's sites, a site's specimens).
    parsed = parse_text(PMAG_TEXT)
    index = _PlotIndex(parsed)
    whole = index.record(7, "contribution", "")
    assert whole["counts"] == compute_counts(parsed)
    assert whole["thumbnails"] == compute_thumbnails(parsed, 7)  # what the index keeps
    assert index.record(7, "locations", "L")["counts"] == whole["counts"]  # all of it is in L

    site_a, site_b = index.record(7, "sites", "A"), index.record(7, "sites", "B")
    assert (site_a["counts"]["zijd"], site_a["counts"]["hyst"], site_a["counts"]["arai"]) == (
        1,
        1,
        0,
    )
    assert site_a["counts"]["eqarea"] == 2  # its specimens' directions, D1's steps
    assert {t["name"] for t in site_a["thumbnails"].values()} == {"A", "D1"}
    assert sorted(site_b["thumbnails"]) == ["arai", "zijd"]
    assert {t["name"] for t in site_b["thumbnails"].values()} == {"S1"}

    d1 = index.record(7, "specimens", "D1")
    assert sorted(d1["thumbnails"]) == ["hyst", "zijd"]
    assert index.record(7, "samples", "D")["counts"] == d1["counts"]
    nowhere = index.record(7, "sites", "nowhere")
    assert not any(nowhere["counts"].values()) and nowhere["thumbnails"] == {}


def test_pmag_plots_thumbnails_are_the_plots_points():
    # One record per plot type, drawn from the same data as its tab: the
    # Zijderveld components and Arai steps of a specimen, a group's
    # equal-area positions, a hysteresis loop over its largest moment.
    parsed = parse_text(PMAG_TEXT)
    plots = compute_plots(parsed)
    thumbnails = compute_thumbnails(parsed, 7)
    assert compute_thumbnails(parsed, 7) == thumbnails  # seeded: a re-index draws the same

    zijd = thumbnails["zijd"]
    specimen = next(s for s in plots["demag"]["specimens"] if s["specimen"] == zijd["name"])
    coords = specimen["coords"].get("g") or specimen["coords"]["s"]
    assert zijd["n"] == pytest.approx(coords["n"], abs=1e-3)
    assert zijd["d"] == pytest.approx(coords["d"], abs=1e-3)

    arai = thumbnails["arai"]
    (steps,) = [s["steps"] for s in plots["arai"]["specimens"] if s["specimen"] == arai["name"]]
    assert (arai["x"], arai["y"]) == (steps["x"], steps["y"])

    eqarea = thumbnails["eqarea"]
    assert len(eqarea["x"]) == len(eqarea["y"]) == len(eqarea["up"]) > 0

    hyst = thumbnails["hyst"]
    assert max(map(abs, hyst["m"])) == 1.0
    assert len(hyst["field"]) == len(hyst["m"])


@pytest.mark.asyncio
async def test_pmag_plots_cache_computes_each_kind_once_and_warms_the_rest():
    reads = 0

    async def read() -> bytes:
        nonlocal reads
        reads += 1
        return PMAG_TEXT.encode()

    plots = _Plots(read)
    # Two tabs asking at once share one computation.
    first, second = await asyncio.gather(plots.get("arai"), plots.get("arai"))
    assert first is second
    body, gzipped = first
    expected = json.loads(json.dumps(compute_plots(parse_text(PMAG_TEXT))["arai"]))
    assert json.loads(body) == expected
    assert gzip.decompress(gzipped) == body
    # The other kinds are computed in the background from the same read, and
    # the parsed file is then let go.
    await plots._warming
    assert reads == 1
    assert set(plots._kinds) == set(KINDS)
    assert plots._source is None
    assert (await plots.get("hyst")) is plots._kinds["hyst"].result()


@pytest.mark.asyncio
async def test_pmag_plots_cache_retries_a_failed_read():
    calls = 0

    async def read() -> bytes:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("bucket unavailable")
        return PMAG_TEXT.encode()

    plots = _Plots(read)
    with pytest.raises(OSError):
        await plots.get("demag")
    body, _ = await plots.get("demag")
    assert json.loads(body)["specimens"]
    await plots._warming
    assert calls == 2
