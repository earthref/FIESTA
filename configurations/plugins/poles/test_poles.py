"""The poles plugin: derived pole docs, their uncertainty rings, and the Locations sub-tab."""

import math

import pytest

from fiesta.domain.parse import parse_text
from fiesta.plugins import active_plugins
from fiesta.plugins import poles as poles_module
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
    # `alpha95` is not `pole_alpha95`, and there is no dp/dm: no ring.
    assert "_geometry" not in doc["summary"]["poles"]


def test_poles_is_searchable_table_not_top_level(magic_node):
    plugins = active_plugins(magic_node)
    assert [p.name for p in plugins][:3] == ["poles", "rock-mag", "pmag-plots"]
    # Poles is NOT a top-level tab...
    assert plugins[0].search_levels(magic_node) == []
    # ...but `poles` is a searchable table, surfaced as a Locations sub-tab.
    assert plugins[0].search_tables(magic_node) == ["poles"]
    cfg = plugins[0].frontend_config(magic_node)
    assert cfg["base_level"] == "Locations" and cfg["after_sub_tab"] == "Rows"


# --- Uncertainty rings (PmagPy) -----------------------------------------------


def _locations_text(rows: list[dict]) -> str:
    columns = sorted({k for row in rows for k in row})
    lines = ["tab delimited\tlocations", "\t".join(columns)]
    lines += ["\t".join(str(row.get(c, "")) for c in columns) for row in rows]
    return "tab delimited\tcontribution\nid\n99\n>>>>>>>>>>\n" + "\n".join(lines) + "\n"


def _docs(magic_node, *rows: dict) -> list[dict]:
    text = _locations_text([{"location": f"L{i}", **row} for i, row in enumerate(rows)])
    return PolesPlugin().derive_docs(magic_node, parse_text(text), {"id": 99})


def _distance(lat1, lon1, lat2, lon2) -> float:
    """Great-circle distance in degrees (independent of PmagPy)."""
    p1, p2, dl = map(math.radians, (lat1, lat2, lon2 - lon1))
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def _bearing(lat1, lon1, lat2, lon2) -> float:
    p1, p2, dl = map(math.radians, (lat1, lat2, lon2 - lon1))
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360


def _geometry(doc: dict) -> dict | None:
    return doc["summary"]["poles"].get("_geometry")


def test_alpha95_ring_is_a_circle_of_radius_alpha95(magic_node):
    (doc,) = _docs(magic_node, {"pole_lat": 78.5, "pole_lon": 260, "pole_alpha95": 3.2})
    geometry = _geometry(doc)
    assert geometry["kind"] == "alpha95"
    ring = geometry["ring"]
    assert len(ring) == poles_module.RING_POINTS and ring[0] == ring[-1]
    for lon, lat in ring:
        assert -180 <= lon < 180
        assert _distance(78.5, 260, lat, lon) == pytest.approx(3.2, abs=0.02)
    # The geometry is on the pole block only, never unioned into _all.
    assert set(doc["summary"]["_all"]) == {"pole_lat", "pole_lon", "_geo_point"}


def test_dp_dm_ring_has_dp_along_the_site_pole_great_circle(magic_node):
    # No alpha95: the dp/dm oval, oriented by the location's box middle (40N, 250E).
    row = {"pole_lat": 78.5, "pole_lon": 260, "pole_dp": 4, "pole_dm": 8}
    row |= {"lat_s": 39, "lat_n": 41, "lon_w": 249, "lon_e": 251}
    (doc,) = _docs(magic_node, row)
    geometry = _geometry(doc)
    assert geometry["kind"] == "dp_dm"
    ring = geometry["ring"]
    assert len(ring) == poles_module.RING_POINTS and ring[0] == ring[-1]
    distances = [_distance(78.5, 260, lat, lon) for lon, lat in ring]
    assert min(distances) == pytest.approx(4, abs=0.02)
    assert max(distances) == pytest.approx(8, abs=0.02)
    toward_site = _bearing(78.5, 260, 40, 250)
    nearest = ring[distances.index(min(distances))]
    farthest = ring[distances.index(max(distances))]
    # dp lies along the great circle to the site (either way), dm across it.
    along = (_bearing(78.5, 260, nearest[1], nearest[0]) - toward_site) % 180
    across = (_bearing(78.5, 260, farthest[1], farthest[0]) - toward_site) % 180
    assert min(along, 180 - along) < 0.5
    assert across == pytest.approx(90, abs=0.5)


def test_dp_dm_orientation_for_a_site_east_of_its_pole(magic_node):
    # Pole on the equator at 0E, site due east at 0N 60E: dp runs east-west.
    row = {"pole_lat": 0, "pole_lon": 0, "pole_dp": 2, "pole_dm": 6}
    row |= {"lat_s": 0, "lat_n": 0, "lon_w": 60, "lon_e": 60}
    (doc,) = _docs(magic_node, row)
    ring = _geometry(doc)["ring"]
    assert max(abs(lon) for lon, _ in ring) == pytest.approx(2, abs=0.02)
    assert max(abs(lat) for _, lat in ring) == pytest.approx(6, abs=0.02)


def test_rings_across_the_date_line_stay_in_plus_minus_180(magic_node):
    east, west_0_360 = _docs(
        magic_node,
        {"pole_lat": 60, "pole_lon": 179, "pole_alpha95": 5},
        {"pole_lat": -70, "pole_lon": 359, "pole_alpha95": 5},
    )
    lons = [lon for lon, _ in _geometry(east)["ring"]]
    assert all(-180 <= lon < 180 for lon in lons)
    assert max(lons) > 175 and min(lons) < -175  # it crosses the antimeridian
    for lon, lat in _geometry(west_0_360)["ring"]:
        assert -180 <= lon < 180
        assert _distance(-70, -1, lat, lon) == pytest.approx(5, abs=0.02)


BOX_0 = {"lat_s": 0, "lat_n": 0, "lon_w": 0, "lon_e": 0}


@pytest.mark.parametrize(
    "row",
    [
        {"pole_alpha95": ""},
        {"pole_alpha95": "abc"},
        {"pole_alpha95": "-1"},
        {"pole_alpha95": "0"},
        {"pole_alpha95": "nan"},
        {"pole_alpha95": "200"},
        {"pole_dp": "", "pole_dm": "5", **BOX_0},
        {"pole_dp": "5", "pole_dm": "120", **BOX_0},
        {"pole_dp": "5", "pole_dm": "5"},  # no site to orient the oval
        {"pole_dp": "5", "pole_dm": "5", **BOX_0, "lat_s": "x"},
        # The site is the pole itself: no great circle between them.
        {"pole_dp": "5", "pole_dm": "5", "lat_s": 78.5, "lat_n": 78.5, "lon_w": 260, "lon_e": 260},
    ],
)
def test_malformed_uncertainties_give_no_ring(magic_node, row):
    (doc,) = _docs(magic_node, {"pole_lat": 78.5, "pole_lon": 260, **row})
    assert _geometry(doc) is None
    assert doc["summary"]["poles"]["pole_lat"] == 78.5


def test_bad_alpha95_falls_back_to_dp_dm(magic_node):
    row = {"pole_lat": 78.5, "pole_lon": 260, "pole_alpha95": "-", "pole_dp": 3, "pole_dm": 5}
    (doc,) = _docs(magic_node, row | {"lat_s": 40, "lat_n": 40, "lon_w": 250, "lon_e": 250})
    assert _geometry(doc)["kind"] == "dp_dm"


def test_a_pmagpy_failure_only_drops_that_ring(magic_node, monkeypatch):
    def boom(*args, **kwargs):
        raise ZeroDivisionError

    monkeypatch.setattr(poles_module.pmag, "circ", boom)
    docs = _docs(
        magic_node,
        {"pole_lat": 78.5, "pole_lon": 260, "pole_alpha95": 3},
        {"pole_lat": 70, "pole_lon": 10, "pole_alpha95": 2},
    )
    assert len(docs) == 2 and all(_geometry(doc) is None for doc in docs)


def test_out_of_range_pole_latitude_keeps_its_doc_without_ring(magic_node):
    (doc,) = _docs(magic_node, {"pole_lat": 95, "pole_lon": 10, "pole_alpha95": 3})
    assert _geometry(doc) is None
    assert "_geo_point" not in doc["summary"]["_all"]
