"""The rock-mag plugin: rock-magnetic result docs, units and derived values."""

import math

import pytest

from fiesta.domain.parse import parse_text
from fiesta.plugins.rock_mag import (
    RockMagPlugin,
    equal_area,
    field_units,
    rock_mag_values,
    tensor_eigen,
)

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
    assert {"v1_x", "v1_y", "v3_x", "v3_y"} <= values.keys()
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
    # A prolate tensor (k1 > k2 = k3): T is -1, and no axes without v1..v3
    # unless the tensor says it is in geographic or tilt-corrected coordinates.
    values = rock_mag_values({"aniso_s": "0.36:0.32:0.32:0:0:0"})
    assert values["t"] == pytest.approx(-1)
    assert values["pj"] > values["p"] == pytest.approx(0.36 / 0.32)
    assert "v1_dec" not in values
    specimen_axes = {"aniso_v1": "0.4:10:5", "aniso_v2": "0.3:100:0", "aniso_v3": "0.3:190:85"}
    assert "v1_dec" not in rock_mag_values({**specimen_axes, "aniso_tilt_correction": "-1"})
    assert "v1_dec" in rock_mag_values({**specimen_axes, "aniso_tilt_correction": "0"})
    # PmagPy normalizes to unit trace; equal eigenvalues (its tauV leaves the
    # middle one at 0) are recovered, and their axes left undefined.
    eigenvalues, axes = tensor_eigen([2, 2, 3, 1, 0, 0])
    assert eigenvalues == pytest.approx([3 / 7, 3 / 7, 1 / 7])
    assert axes[0] is None and axes[2] is not None
    # Malformed tensors never raise.
    assert tensor_eigen([0, 0, 0, 0, 0, 0]) is None
    assert tensor_eigen([1e39, 0, 0, 0, 0, 0]) is None
    assert rock_mag_values({"aniso_s": "a:b:c:d:e:f", "aniso_tilt_correction": "0"}) == {}
    # Non-physical ratios are left out.
    assert rock_mag_values({"hyst_mr_ms": "1.4", "hyst_bc": "-0.01"}) == {}


def test_rock_mag_axes_from_a_geographic_tensor():
    # k1 along north, k3 vertical: PmagPy's eigenvectors give V1 = 0/0 and
    # V3 = 0/90 when the tensor is in geographic coordinates.
    row = {"aniso_s": "0.4:0.35:0.25:0:0:0", "aniso_tilt_correction": "0"}
    values = rock_mag_values(row)
    assert (values["v1_dec"], values["v1_inc"]) == pytest.approx((0, 0))
    assert values["v3_inc"] == pytest.approx(90)
    assert (values["v1_x"], values["v1_y"]) == pytest.approx((0, 1))
    assert (values["v3_x"], values["v3_y"]) == pytest.approx((0, 0), abs=1e-6)
    assert values["p"] == pytest.approx(0.4 / 0.25, rel=1e-6)
    # A tilt-corrected tensor too; a blank tilt correction is specimen
    # coordinates, as PmagPy reads it.
    assert "v3_x" in rock_mag_values({**row, "aniso_tilt_correction": "100"})
    assert "v1_dec" not in rock_mag_values({"aniso_s": row["aniso_s"]})


def test_rock_mag_projected_axes():
    # x east, y north on the unit net; an upward axis is drawn as its
    # lower-hemisphere opposite.
    values = rock_mag_values(
        {"aniso_v1": "0.36:90:0", "aniso_v2": "0.33:0:0", "aniso_v3": "0.31:0:-30"}
    )
    assert (values["v1_x"], values["v1_y"]) == pytest.approx((1, 0), abs=1e-9)
    assert values["v3_inc"] == -30.0
    radius = (1 - math.sin(math.radians(30))) ** 0.5
    assert (values["v3_x"], values["v3_y"]) == pytest.approx((0, -radius), abs=1e-9)
    assert equal_area(45, 90) == pytest.approx((0, 0))
