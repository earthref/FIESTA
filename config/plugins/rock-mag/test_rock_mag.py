"""The rock-mag plugin: rock-magnetic result docs, units and derived values."""

import pytest

from fiesta.domain.parse import parse_text
from fiesta.plugins.rock_mag import (
    RockMagPlugin,
    field_units,
    rock_mag_values,
    symmetric_eigenvalues,
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
