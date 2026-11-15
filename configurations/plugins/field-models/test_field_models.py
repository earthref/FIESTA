"""The field-models plugin: the SHMODEL port against reference numbers from
the compiled Fortran, the epoch-table conversions, ensemble statistics,
GEOMAGIA's request validation and location handling. No network or
infrastructure: models are tiny synthetic ones (a real downloaded model is
used only when FIESTA_FIELD_MODELS_DIR points at fetch_models.py --out)."""

import io
import math
import os
import zipfile
from pathlib import Path

import numpy as np
import pytest
from fastapi import HTTPException

from fiesta.nodeconfig import load_deployment
from fiesta.plugins import active_plugins
from fiesta.plugins.field_models import (
    CurveRequest,
    FieldModelsOptions,
    FieldModelsPlugin,
    convert,
    global_payload,
    model_curves,
    resolve_locations,
    selection_locations,
    shmodel,
    validate_window,
)

CONFIG_DIR = Path(__file__).resolve().parents[2]

# Agreement with the Fortran (GEOMAGIA's intensity.f90 + anymodel.f SHMODEL,
# gfortran 15.2 -O2): measured at <= 1e-11 relative on 12 public models;
# asserted here with margin.
REL = 1e-9

# --- A synthetic degree-3 model with an uncertainty array ---------------------------

BASE = [
    -30000,
    -2000,
    5000,
    -1500,
    3000,
    -2500,
    1500,
    -500,
    1300,
    -2300,
    -200,
    1250,
    250,
    700,
    -200,
]


def synthetic_model_text() -> str:
    """Degree 3, 7 cubic B-splines on knots 700..1700 (valid 1000-1400)."""
    knots = [1000 + 100 * (i - 3) for i in range(11)]
    rows = [
        [round(b + 300 * math.sin(0.7 * s + 1.3 * k), 6) for k, b in enumerate(BASE)]
        for s in range(7)
    ]
    errors = [[20 + 5 * k + s for k in range(15)] for s in range(7)]
    lines = ["1000 1400 synthetic", "3 0 7", " ".join(map(str, knots))]
    lines += [" ".join(f"{v:.6f}" for v in row) for row in rows]
    lines += [" ".join(str(v) for v in row) for row in errors]
    return "\n".join(lines) + "\n"


# Fortran outputs for synthetic_model_text() (site, year, F uT, D, I, EF uT, ED, EI)
# at altitude 2.5 km.
CURVE_REFERENCE = [
    (
        50.0,
        10.0,
        1000.0,
        51.03907425701031,
        0.781790336248558,
        60.23328064609156,
        0.2887465265979979,
        0.4904880361574446,
        0.24938651356153668,
    ),
    (
        50.0,
        10.0,
        1137.5,
        50.00649443124697,
        1.4737300323876588,
        61.011550647576996,
        0.296560809125842,
        0.522729403018246,
        0.25823628839416995,
    ),
    (
        50.0,
        10.0,
        1400.0,
        50.39724250376413,
        1.4893641416832777,
        62.822492071151544,
        0.31215579034258084,
        0.5703271445643492,
        0.2622087686344672,
    ),
    (
        -33.9,
        18.4,
        1000.0,
        30.49130576954962,
        -25.372110805044084,
        -58.029572482478656,
        0.3067616013082191,
        0.7712130586224871,
        0.4584420499960799,
    ),
    (
        -33.9,
        18.4,
        1137.5,
        30.754528860671467,
        -23.959816689553705,
        -57.7310549336544,
        0.3123199668835119,
        0.7751260734208164,
        0.46464148368664343,
    ),
    (
        -33.9,
        18.4,
        1400.0,
        31.303011131343894,
        -22.78983533396387,
        -57.8240246993082,
        0.3244723767904362,
        0.792695156067523,
        0.4733039356967776,
    ),
]
# --global at 1250: (lat, lon, F, D, I, Br mT, dF/dt^2, dBr/dt^2).
GLOBAL_REFERENCE = [
    (
        -90.0,
        -180.0,
        52.405607980207705,
        145.24770498026052,
        -72.56287629678997,
        0.20277735277262487,
        0.0313573323948191,
        0.37908172691588043,
    ),
    (
        0.0,
        0.0,
        26.012896226958844,
        -8.691099565593355,
        -19.807084110981155,
        0.19245770323312772,
        0.023153043537784735,
        0.646199745511909,
    ),
    (
        50.0,
        50.0,
        54.27908442959826,
        7.0827841325380145,
        67.14581009599637,
        -0.39366313587519897,
        0.05028134571025448,
        -0.5693340994002645,
    ),
    (
        85.0,
        120.0,
        58.94590204706867,
        -26.974266232427233,
        86.54714463538184,
        -0.3014022240404137,
        0.033326023716378286,
        -0.37323055921431314,
    ),
]


@pytest.fixture(scope="module")
def synthetic():
    return shmodel.parse_model(synthetic_model_text(), "synthetic")


def test_parse_model_layout(synthetic):
    assert (synthetic.degree, synthetic.splines, synthetic.start, synthetic.end) == (
        3,
        7,
        1000,
        1400,
    )
    assert synthetic.has_uncertainty
    with pytest.raises(ValueError, match="layout"):
        shmodel.parse_model(synthetic_model_text() + "1 2 3\n", "bad")


def test_curves_match_the_fortran(synthetic):
    sites = sorted({(r[0], r[1]) for r in CURVE_REFERENCE})
    for lat, lon in sites:
        rows = [r for r in CURVE_REFERENCE if (r[0], r[1]) == (lat, lon)]
        out = shmodel.synthesize(synthetic, [r[2] for r in rows], [lat], [lon], 2.5)
        for i, r in enumerate(rows):
            for key, expected in zip(
                (
                    "intensity",
                    "decl",
                    "incl",
                    "intensity_uncertainty",
                    "decl_uncertainty",
                    "incl_uncertainty",
                ),
                r[3:],
                strict=True,
            ):
                assert out[key][i, 0] == pytest.approx(expected, rel=REL, abs=1e-9), (
                    lat,
                    lon,
                    r[2],
                    key,
                )


def test_global_grid_matches_the_fortran(synthetic):
    frame = shmodel.global_frame(synthetic, 1250.0)
    lats, lons = list(frame["latitudes"]), list(frame["longitudes"])
    for lat, lon, *expected in GLOBAL_REFERENCE:
        i, j = lats.index(lat), lons.index(lon)
        for key, value in zip(
            (
                "intensity",
                "decl",
                "incl",
                "radial",
                "intensity_acceleration",
                "radial_acceleration",
            ),
            expected,
            strict=True,
        ):
            assert frame[key][i, j] == pytest.approx(value, rel=REL, abs=1e-9), (lat, lon, key)


def test_axial_dipole_at_the_equator_and_pole():
    """A pure g10 = -30000 nT: horizontal at the equator, vertical at the
    pole, scaled by (a/r)^3 on the ellipsoid (radii from COORDS' constants)."""
    text = "0 100\n1 0 4\n-300 -200 -100 0 100 200 300 400\n" + "-30000 0 0\n" * 4
    model = shmodel.parse_model(text, "dipole")
    out = shmodel.synthesize(model, [50.0], [0.0, 90.0], [0.0, 0.0], 0.0)
    a = shmodel.REFERENCE_RADIUS
    equator = math.sqrt(shmodel._B1)
    pole = math.sqrt(shmodel._B2)
    assert out["intensity"][0, 0] == pytest.approx(30.0 * (a / equator) ** 3, rel=1e-7)
    # Single-precision FAC and pi put "0 deg" a hair off the equator.
    assert out["incl"][0, 0] == pytest.approx(0.0, abs=1e-5)
    assert out["intensity"][0, 1] == pytest.approx(60.0 * (a / pole) ** 3, rel=1e-6)
    assert out["incl"][0, 1] == pytest.approx(90.0, abs=1e-3)


def test_no_extrapolation(synthetic):
    with pytest.raises(ValueError, match="covers"):
        shmodel.synthesize(synthetic, [999.0], [0.0], [0.0])
    with pytest.raises(ValueError, match="covers"):
        shmodel.global_frame(synthetic, 1401.0)


def test_curve_years_always_end_at_the_end():
    assert list(shmodel.curve_years(1000, 1035, 10)) == [1000, 1010, 1020, 1030, 1035]


# --- Conversions ----------------------------------------------------------------------


def test_natural_spline_reproduces_epochs_and_is_natural():
    times = [-100.0, -50.0, 0.0, 50.0, 120.0]
    rows = [[float(i * 10 + k) ** 1.5 - 7 * k for k in range(3)] for i in range(5)]
    model = shmodel.parse_model(convert.convert_epochs(times, rows), "epochs")
    g, _ = shmodel.gauss_coefficients(model, times)
    assert np.max(np.abs(g - np.asarray(rows))) < 1e-9
    # Linear data stay linear between epochs (zero curvature everywhere).
    linear = [[2.0 * t + k for k in range(3)] for t in times]
    lin = shmodel.parse_model(convert.convert_epochs(times, linear), "linear")
    g, _ = shmodel.gauss_coefficients(lin, [-75.0, 85.0])
    assert g[:, 0] == pytest.approx([-150.0, 170.0])


def test_kalmag_mean_std_keeps_the_means():
    text = " 0 0 50 50\n 1 0.1 2 0.2\n 3 0.3 4 0.4\n 5 0.5 6 0.6\n"
    times, rows = convert.read_epoch_matrix(text)
    assert times == [0.0, 50.0]
    assert rows == [[1.0, 3.0, 5.0], [2.0, 4.0, 6.0]]


def test_sha_dif_rows_to_nt():
    text = "\n".join(
        f"{t} {n} {m} {g} {h}"
        for t in (-12000, -11950)
        for n, m, g, h in ((1, 0, -20.0, 0), (1, 1, 0.5, -4.0))
    )
    times, rows = convert.read_sha_dif(text)
    assert times == [-12000.0, -11950.0]
    assert rows[0] == [-20000.0, 500.0, -4000.0]


def test_ggfss70_ka_bp_becomes_calendar_years():
    text = "15 70\n1 0 4\n10 20 30 40 50 60 70 80\n1 0 0\n2 0 0\n3 0 0\n4 0 0\n"
    start, end, _, knots, rows, _ = convert.read_standard(convert.reverse_ka_bp(text))
    assert (start, end) == (1950 - 70_000, 1950 - 15_000)
    assert knots[0] == 1950 - 80_000 and knots[-1] == 1950 - 10_000
    assert [r[0] for r in rows] == [4, 3, 2, 1]


def _xlsx(rows) -> bytes:
    out = io.BytesIO()
    cells = "".join(
        f'<row r="{r + 1}">'
        + "".join(
            f'<c r="{chr(65 + c)}{r + 1}" t="inlineStr"><is><t>{v}</t></is></c>'
            if isinstance(v, str)
            else f'<c r="{chr(65 + c)}{r + 1}"><v>{v}</v></c>'
            for c, v in enumerate(row)
        )
        + "</row>"
        for r, row in enumerate(rows)
    )
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(
            "xl/workbook.xml",
            f"<workbook {ns} {rel}><sheets>"
            '<sheet name="Model Coefficients (microT)" sheetId="1" r:id="rId1"/>'
            "</sheets></workbook>",
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>'
            "</Relationships>",
        )
        z.writestr(
            "xl/worksheets/sheet1.xml",
            f"<worksheet {ns}><sheetData>{cells}</sheetData></worksheet>",
        )
    return out.getvalue()


def test_shawq_workbook():
    data = _xlsx(
        [["SHAWQ"], ["year", "g10", "g11", "h11"], [-100, -30.5, -2, 5], [-50, -30, -2.5, 5.5]]
    )
    times, rows = convert.read_shawq(data)
    assert times == [-100.0, -50.0]
    assert rows[1] == [-30000.0, -2500.0, 5500.0]


# --- Ensembles ----------------------------------------------------------------------------


def test_ensemble_sd_of_a_dipole_family_is_linear_in_g10():
    deltas = np.array([-300.0, -100.0, 0.0, 150.0, 250.0])
    times = [0.0, 100.0, 200.0]
    cube = np.zeros((3, 3, len(deltas)))
    cube[:, 0, :] = -30000.0 + deltas
    vector = shmodel.ensemble_predictions(cube, times, [0.0, 50.0, 200.0], 90.0, 0.0, 0.0)
    errors, members = shmodel.ensemble_statistics(vector, include_members=True)
    pole = math.sqrt(shmodel._B2)
    expected = 2 * np.std(deltas, ddof=1) * (shmodel.REFERENCE_RADIUS / pole) ** 3 / 1000
    assert errors["intensity_uncertainty"] == pytest.approx([expected] * 3, rel=1e-5)
    assert members["intensity"].shape == (5, 3)
    same = np.repeat(cube[:, :, 2:3], 4, axis=2)
    zero, _ = shmodel.ensemble_statistics(
        shmodel.ensemble_predictions(same, times, [10.0], 45.0, 10.0, 0.0)
    )
    assert zero["intensity_uncertainty"][0] == 0.0


def test_interpolation_weights_hit_the_epochs():
    w = shmodel.interpolation_weights((0.0, 10.0, 30.0, 35.0), (0.0, 10.0, 35.0))
    assert np.allclose(w, np.eye(4)[[0, 1, 3]])
    with pytest.raises(ValueError):
        shmodel.interpolation_weights((0.0, 10.0), (11.0,))


# --- Locations, validation, routes ------------------------------------------------------------


def test_selection_locations_split_intensity_and_direction():
    groups = selection_locations(
        [
            [45.0, 370.0, 50.0, None, None],  # longitude out of range: dropped
            [45.0, 350.0, 50.0, None, None],  # intensity, lon -> -10
            [45.0, 180.0, None, 999.0, 60.0],  # direction by inclination only, lon -> -180
            [10.0, 20.0, -1.0, None, 95.0],  # neither
            [10.0, 20.0, 0.0, 10.0, None],  # both (intensity >= 0)
        ]
    )
    assert groups["intensity"] == [(10.0, 20.0), (45.0, -10.0)]
    assert groups["direction"] == [(10.0, 20.0), (45.0, -180.0)]


def test_median_location_unwraps_the_date_line():
    lat, lon = shmodel.median_location([(10.0, 179.0), (20.0, -179.0), (30.0, 178.0)])
    assert lat == 20.0 and lon == pytest.approx(179.0)


def _entry(name="synthetic", start=1000.0, end=1400.0):
    return {
        "name": name,
        "group": "mixed",
        "author": "Test",
        "year": 2026,
        "citation": "Test model.",
        "doi": None,
        "terms": "none stated",
        "source_url": "https://example.org",
        "interpolated_epochs": False,
        "sha256": "0" * 64,
        "start": start,
        "end": end,
        "degree": 3,
        "has_uncertainty": True,
        "ensemble": None,
    }


def _request(**kw):
    base = {
        "models": ["synthetic"],
        "start_year": 1000,
        "end_year": 1400,
        "step": 10,
        "latitude": 50,
        "longitude": 10,
    }
    return CurveRequest(**{**base, **kw})


def test_validation_follows_geomagia():
    entry = _entry()
    catalog = [entry, _entry("old", -10000, 1990)]
    assert validate_window(_request(start_year=900, end_year=1500), [entry], catalog, 1) == {
        "synthetic": (1000, 1400)
    }
    with pytest.raises(HTTPException, match="no time interval"):
        validate_window(_request(start_year=1500, end_year=1900), [entry], catalog, 1)
    with pytest.raises(HTTPException, match="at most 4,001 points"):
        long = _request(models=["old"], start_year=-10000, end_year=1990, step=1)
        validate_window(long, [catalog[1]], catalog, 1)
    with pytest.raises(HTTPException, match="at least 1 year"):
        validate_window(_request(step=0.5), [entry], catalog, 1)
    with pytest.raises(HTTPException, match="1,000 curves"):
        validate_window(_request(), [entry], catalog, 1001)
    with pytest.raises(HTTPException, match="after the start"):
        validate_window(_request(start_year=1300, end_year=1200), [entry], catalog, 1)
    with pytest.raises(HTTPException, match="altitude"):
        resolve_locations(_request(altitude=101), FieldModelsOptions())


def test_search_locations_and_medians():
    request = _request(
        location_source="database",
        use_median=True,
        sites=[
            [40.0, 10.0, 50.0, None, None],
            [42.0, 12.0, 55.0, 5.0, 60.0],
            [44.0, 14.0, None, 3.0, None],
        ],
    )
    locations, membership, extra, altitude = resolve_locations(request, FieldModelsOptions())
    assert altitude == 0.0
    assert extra["component_location_counts"] == {"intensity": 2, "direction": 2}
    assert extra["median_locations"]["intensity"] == {"latitude": 41.0, "longitude": 11.0}
    assert locations == [(41.0, 11.0), (43.0, 13.0)]
    assert membership[(41.0, 11.0)] == ["intensity"]
    with pytest.raises(HTTPException, match="no valid locations"):
        resolve_locations(
            _request(location_source="database", sites=[[None, None, 1.0, None, None]]),
            FieldModelsOptions(),
        )


def test_model_curves_and_vadm(synthetic):
    series = model_curves(synthetic, _entry(), (1000.0, 1400.0), 100.0, [(50.0, 10.0)], 0.0, None)
    [curve] = series
    assert curve["years"] == [1000.0, 1100.0, 1200.0, 1300.0, 1400.0]
    factor = shmodel.vadm_factor(50.0)
    assert curve["vadm"][2] == pytest.approx(curve["intensity"][2] * factor)
    assert (
        curve["uncertainty"] is not None and curve["coefficient_metadata"]["terms"] == "none stated"
    )


def test_global_payload_shape(synthetic):
    frame = global_payload(synthetic, _entry(), 1200.0)
    assert (frame["nlat"], frame["nlon"]) == (37, 72)
    assert len(frame["intensity"]) == 37 * 72
    # Delta I is zero for an axial dipole field only; here it is I - GAD.
    assert frame["delta_incl"][0] == pytest.approx(
        frame["incl"][0] - shmodel.gad_inclination(-90.0), abs=1e-5
    )


def test_geomagia_activates_the_plugin():
    node = load_deployment(CONFIG_DIR / "geomagia.yaml").node_for("geomagia")
    plugin = next(p for p in active_plugins(node) if p.name == "field-models")
    assert isinstance(plugin, FieldModelsPlugin)
    config = plugin.frontend_config(node)
    assert config["base_level"] == "Sites" and config["table"] == "sites"


def test_manifest_pins_every_source():
    import yaml

    manifest = yaml.safe_load((Path(__file__).with_name("models.yaml")).read_text(encoding="utf-8"))
    for entry in manifest["models"]:
        sources = [entry["source"], *([entry["ensemble"]["source"]] if "ensemble" in entry else [])]
        for source in sources:
            assert len(source["sha256"]) == 64, entry["name"]
        assert entry["citation"] and entry["terms"] and entry["group"]
    assert {"ARCH-UK.1", "ARCH3K.1e", "SED3K.1e", "CALS3K.3e", "BIGMUDI4k.1"} <= set(
        manifest["unavailable"]
    )


# --- A real model, when fetched -----------------------------------------------------------------

MODELS_DIR = os.environ.get("FIESTA_FIELD_MODELS_DIR")
# Fortran outputs for GFZ's CALS10k.2 at 50N 10E, sea level: year, F, D, I.
CALS10K2_REFERENCE = [
    (-8000.0, 44.153298136198146, -2.8380284659633266, 58.98582728993517),
    (-1000.0, 73.33952498045076, 10.353362082241677, 70.59497534704603),
    (0.0, 66.7872603906331, -3.0927440470253367, 66.44906982054943),
    (1000.0, 69.16881238084586, 17.960509623871143, 65.93554175400675),
    (1990.0, 47.98541357229441, -0.5098912777625008, 65.50553575094733),
]


@pytest.mark.skipif(
    not MODELS_DIR or not (Path(MODELS_DIR or ".") / "models" / "CALS10k.2.txt").exists(),
    reason="set FIESTA_FIELD_MODELS_DIR to a fetch_models.py --out directory",
)
def test_cals10k2_matches_the_fortran():
    text = (Path(MODELS_DIR) / "models" / "CALS10k.2.txt").read_text(encoding="latin-1")
    model = shmodel.parse_model(text, "CALS10k.2")
    out = shmodel.synthesize(model, [r[0] for r in CALS10K2_REFERENCE], [50.0], [10.0], 0.0)
    for i, (_, f, d, inc) in enumerate(CALS10K2_REFERENCE):
        assert out["intensity"][i, 0] == pytest.approx(f, rel=REL)
        assert out["decl"][i, 0] == pytest.approx(d, rel=REL, abs=1e-9)
        assert out["incl"][i, 0] == pytest.approx(inc, rel=REL)
