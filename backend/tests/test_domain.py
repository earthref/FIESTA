from pathlib import Path

import pytest

from fiesta.domain.parse import ParseError, export_text, parse_text, stamp_ids
from fiesta.domain.summarize import summarize
from fiesta.domain.validate import guess_data_model_version, validate_contribution
from fiesta.nodeconfig import load_deployment

CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"

# Longitudes are 0-360 per the MagIC data model (min 0.0).
MAGIC_TEXT = """tab delimited\tcontribution
id\tversion\tdata_model_version\treference\tlab_names
12345\t1\t3.0\t10.1029/93JB00024\tPaleomagnetic Laboratory (AGICO Inc., Czech Republic)
>>>>>>>>>>
tab delimited\tlocations
location\tlocation_type\tgeologic_classes\tlithologies\tage_unit\tlat_s\tlat_n\tlon_w\tlon_e
Hawaii\tOutcrop\tIgneous\tBasalt\tMa\t19.0\t20.3\t203.9\t205.2
>>>>>>>>>>
tab delimited\tsites
site\tlocation\tcitations\tgeologic_types\tgeologic_classes\tlithologies\tage_unit\tlat\tlon\tmethod_codes
HW01\tHawaii\tThis study\tLava Flow\tIgneous\tBasalt\tMa\t19.5\t204.5\tLP-DC3:SM-VSM
HW02\tHawaii\tThis study\tLava Flow\tIgneous\tBasalt\tMa\t19.7\t204.6\tLP-DC3
"""


def test_parse_roundtrip(magic_node):
    parsed = parse_text(MAGIC_TEXT)
    assert set(parsed.tables) == {"contribution", "locations", "sites"}
    assert parsed.row_count("sites") == 2
    assert parsed.tables["sites"][0]["site"] == "HW01"

    model = magic_node.load_data_model("3.0")
    text = export_text(parsed, model)
    reparsed = parse_text(text)
    assert reparsed.tables == parsed.tables


def test_parse_rejects_garbage():
    with pytest.raises(ParseError):
        parse_text("not a valid header\nfoo\tbar\n")


def test_parse_empty_column_name():
    # A trailing tab in the header is not a column; a blank header cell over real
    # values (legacy MagIC 11881) keeps them under a placeholder that validation
    # reports as unrecognized, rather than losing the row or the contribution.
    parsed = parse_text("tab delimited\tsites\nsite\tlat\t\nHW01\t1.5\t\n")
    assert parsed.tables["sites"] == [{"site": "HW01", "lat": "1.5"}]
    parsed = parse_text("tab delimited\tsites\nsite\t\tlat\nHW01\tx\t1.5\n")
    assert parsed.tables["sites"] == [{"site": "HW01", "_unnamed_2": "x", "lat": "1.5"}]


def test_stamp_ids(magic_node):
    model = magic_node.load_data_model("3.0")
    text = stamp_ids(MAGIC_TEXT + ">>>>>>>>>>\ntab delimited\tnot_a_table\na\nb\n", 777, model)
    parsed = parse_text(text)
    assert parsed.tables["contribution"][0]["id"] == "777"
    assert [(r["contribution_id"], r["row_id"]) for r in parsed.tables["locations"]] == [
        ("777", "1")
    ]
    assert [(r["contribution_id"], r["row_id"]) for r in parsed.tables["sites"]] == [
        ("777", "2"),
        ("777", "3"),
    ]
    assert text.split("\n")[5] == "contribution_id\trow_id\tlocation\tlocation_type" + (
        MAGIC_TEXT.split("\n")[5].removeprefix("location\tlocation_type")
    )
    assert parsed.tables["not_a_table"] == [{"a": "b"}]
    stamped = parse_text(stamp_ids(MAGIC_TEXT, 777, model))
    assert validate_contribution(magic_node, stamped).errors == []
    # Stamping a download again (e.g. as a new version) overwrites, never adds.
    restamped = parse_text(stamp_ids(text, 778, model))
    assert restamped.tables["sites"][1] == {**parsed.tables["sites"][1], "contribution_id": "778"}
    docs = summarize(magic_node, parsed, {"id": 777})
    assert all("row_id" not in d["summary"]["_all"] for d in docs if "_all" in d["summary"])
    # A model that does not declare the columns (MagIC 2.5 sites) is left alone.
    legacy = "tab delimited\ter_sites\ner_site_name\nHW01\n"
    assert stamp_ids(legacy, 777, magic_node.load_data_model("2.5")) == legacy


def test_guess_version(magic_node):
    assert guess_data_model_version(magic_node, parse_text(MAGIC_TEXT)) == "3.0"


def test_validate_accepts_good_contribution(magic_node):
    report = validate_contribution(magic_node, parse_text(MAGIC_TEXT))
    assert report.errors == []


def test_validate_flags_bad_column_value_and_table(magic_node):
    bad = (
        MAGIC_TEXT
        + """>>>>>>>>>>
tab delimited\tsites
site\tlocation\tlat\tnot_a_real_column
HW03\tHawaii\tnot-a-number\tx
>>>>>>>>>>
tab delimited\tnot_a_table
foo
bar
"""
    )
    report = validate_contribution(magic_node, parse_text(bad))
    messages = " | ".join(e.message for e in report.errors)
    assert "not_a_real_column" in messages
    assert "not-a-number" in messages
    assert "not_a_table" in messages


def test_validate_controlled_vocabulary(magic_node):
    bad = MAGIC_TEXT.replace("Igneous", "NotARealGeologicClass")
    report = validate_contribution(magic_node, parse_text(bad))
    assert any("NotARealGeologicClass" in e.message for e in report.errors)


def test_summarize_docs(magic_node):
    parsed = parse_text(MAGIC_TEXT)
    meta = {
        "id": 12345,
        "version": 1,
        "_contributor": "Test User",
        "_contributor_id": 1,
        "_private_key": "k",
        "_is_activated": True,
        "_is_latest": True,
    }
    docs = summarize(magic_node, parsed, meta)
    by_type = {}
    for doc in docs:
        by_type.setdefault(doc["type"], []).append(doc)
    assert len(by_type["contribution"]) == 1
    assert len(by_type["locations"]) == 1
    assert len(by_type["sites"]) == 2

    contribution = by_type["contribution"][0]
    assert contribution["summary"]["sites"]["_n_results"] == 2
    assert contribution["summary"]["contribution"]["_is_latest"] is True
    # method_codes from site rows roll up into the contribution-level _all
    assert "LP-DC3" in contribution["summary"]["_all"]["method_codes"]
    site_doc = by_type["sites"][0]
    assert site_doc["summary"]["_all"]["_geo_point"] == {"lat": 19.5, "lon": -155.5}


def test_summarize_places_other_bodies(magic_node):
    # A lunar location's sites (and a sample below one, by its site) are on
    # the Moon: _body_point, never _geo_point, so Earth's filters skip them.
    text = "\n>>>>>>>>>>\n".join(
        [
            _tab_block("contribution", ["id"], [{"id": 1}]),
            _tab_block(
                "locations",
                ["location", "location_type", "lat", "lon"],
                [
                    {"location": "Hawaii", "location_type": "Outcrop", "lat": 19.5, "lon": 204.5},
                    {"location": "Apollo 11", "location_type": "Lunar", "lat": 0.67, "lon": 23.47},
                ],
            ),
            _tab_block(
                "sites",
                ["site", "location", "lat", "lon"],
                [
                    {"site": "HW01", "location": "Hawaii", "lat": 19.5, "lon": 204.5},
                    {"site": "10020", "location": "Apollo 11", "lat": 0.67, "lon": 23.47},
                ],
            ),
            _tab_block("samples", ["sample", "site"], [{"sample": "10020,1", "site": "10020"}]),
        ]
    )
    docs = summarize(magic_node, parse_text(text), {"id": 1})
    by_name = {
        (d["type"], d["summary"][d["type"]].get(d["type"].removesuffix("s"))): d["summary"]["_all"]
        for d in docs
        if d["type"] != "contribution"
    }
    moon = {"lat": 0.67, "lon": 23.47, "body": "moon"}
    for key in [("locations", "Apollo 11"), ("sites", "10020")]:
        assert by_name[key]["_body_point"] == moon
        assert "_geo_point" not in by_name[key]
    # Positioned by its site, on its site's body.
    assert by_name[("samples", "10020,1")]["_body_point"] == moon
    assert by_name[("sites", "HW01")]["_geo_point"] == {"lat": 19.5, "lon": -155.5}
    contribution = docs[0]["summary"]["_all"]
    assert contribution["_body_point"] == [moon]
    assert all("body" not in p for p in contribution["_geo_point"])


def test_summarize_groups_a_records_rows(magic_node):
    # A specimen's rows (e.g. a hysteresis and an anisotropy result) are one
    # doc, as in the legacy index: Summaries count records, Rows their rows.
    text = "\n>>>>>>>>>>\n".join(
        [
            _tab_block(
                "contribution",
                ["id", "data_model_version"],
                [{"id": 1, "data_model_version": "3.0"}],
            ),
            _tab_block(
                "specimens",
                ["specimen", "sample", "method_codes", "hyst_bc", "aniso_type"],
                [
                    {"specimen": "S1", "sample": "A", "method_codes": "LP-HYS", "hyst_bc": "0.01"},
                    {
                        "specimen": "S1",
                        "sample": "A",
                        "method_codes": "LP-AN-MS",
                        "aniso_type": "AMS",
                    },
                    {"specimen": "S2", "sample": "A", "method_codes": "LP-HYS"},
                    {"specimen": "", "sample": "A"},
                ],
            ),
        ]
    )
    docs = [
        d for d in summarize(magic_node, parse_text(text), {"id": 1}) if d["type"] == "specimens"
    ]
    assert [len(d["rows"]) for d in docs] == [2, 1, 1]
    s1 = docs[0]["summary"]
    assert s1["specimens"]["_n_results"] == 2
    # Each column's first value, from whichever row has it.
    assert (s1["specimens"]["hyst_bc"], s1["specimens"]["aniso_type"]) == ("0.01", "AMS")
    assert s1["_all"]["method_codes"] == ["LP-AN-MS", "LP-HYS"]


def test_karar_config_loads(karar_node):
    assert karar_node.hierarchy[-1] == "measurements"
    assert karar_node.search.index == "karar"


def _tab_block(table, columns, rows):
    lines = [f"tab delimited\t{table}", "\t".join(columns)]
    lines += ["\t".join(str(row.get(c, "")) for c in columns) for row in rows]
    return "\n".join(lines)


# An ERDA contribution: digital objects with discovery metadata plus the files
# that make them up. Modelled on the legacy records ERDA/1 and ERDA/155.
ERDA_TEXT = "\n>>>>>>>>>>\n".join(
    [
        _tab_block(
            "contribution",
            ["id", "version", "data_model_version", "reference"],
            [
                {
                    "id": 155,
                    "version": 1,
                    "data_model_version": "1.0",
                    "reference": "10.1029/2003GC000626",
                }
            ],
        ),
        _tab_block(
            "objects",
            [
                "object",
                "title",
                "data_types",
                "expert_level",
                "keywords",
                "computer_program",
                "project",
                "project_group",
                "continents_oceans",
                "countries",
                "locations",
                "lat",
                "lon",
                "age_high",
                "age_low",
                "age_unit",
                "timescale_epoch",
                "license",
            ],
            [
                {
                    "object": "df2000-hydrocast",
                    "title": "DeepFreeze 2000 hydrocast data for Vailulu'u volcano",
                    "data_types": "graphs:spreadsheet",
                    "expert_level": "State-of-the-art Science",
                    "keywords": "Seamount:Hotspot:CTD",
                    "computer_program": "Microsoft Excel",
                    "project": "Vailulu'u: the Active Samoan Hotspot Volcano",
                    "project_group": "Other Projects",
                    "continents_oceans": "Pacific Ocean",
                    "countries": "American Samoa",
                    "locations": "Vailulu'u Volcano:Samoan Islands",
                    "lat": -14.2122,
                    "lon": -169.0573,
                    "age_high": 1,
                    "age_low": 0,
                    "age_unit": "Ma",
                    "timescale_epoch": "Holocene",
                    "license": "CC BY 4.0",
                },
                {
                    "object": "garnet-peridotite-xenoliths",
                    "title": "Composition database of garnet peridotite xenoliths",
                    "data_types": "spreadsheet:data",
                    "expert_level": "College and Introduction to Science",
                    "keywords": "xenolith:peridotite:garnet:REE",
                    "computer_program": "Microsoft Excel",
                    "license": "CC BY 4.0",
                },
            ],
        ),
        _tab_block(
            "files",
            ["file", "object", "format", "media_type", "size_bytes"],
            [
                {
                    "file": "df2000.cmb.zip",
                    "object": "df2000-hydrocast",
                    "format": "zip",
                    "media_type": "application/zip",
                    "size_bytes": 2306867,
                },
                {
                    "file": "garnet.peridotite.xenoliths.xls",
                    "object": "garnet-peridotite-xenoliths",
                    "format": "xls",
                    "media_type": "application/vnd.ms-excel",
                    "size_bytes": 503808,
                },
            ],
        ),
    ]
)


def test_erda_config_loads(erda_node):
    assert erda_node.hierarchy == ["contribution", "objects", "files"]
    assert erda_node.search.index == "erda"
    assert erda_node.doi.prefix == "10.7288/V4/ERDA"


def test_erda_validate_accepts_good_contribution(erda_node):
    report = validate_contribution(erda_node, parse_text(ERDA_TEXT))
    assert report.errors == []


def test_erda_validate_controlled_vocabularies(erda_node):
    bad = ERDA_TEXT.replace("graphs:spreadsheet", "graphs:not-a-data-type")
    bad = bad.replace("State-of-the-art Science", "Postdoctoral")
    report = validate_contribution(erda_node, parse_text(bad))
    messages = " | ".join(e.message for e in report.errors)
    assert "not-a-data-type" in messages
    assert "Postdoctoral" in messages


def test_erda_summarize_docs(erda_node):
    meta = {"id": 155, "version": 1, "_is_activated": True, "_is_latest": True}
    docs = summarize(erda_node, parse_text(ERDA_TEXT), meta)
    by_type = {}
    for doc in docs:
        by_type.setdefault(doc["type"], []).append(doc)
    assert len(by_type["objects"]) == 2
    assert len(by_type["files"]) == 2

    contribution = by_type["contribution"][0]
    assert contribution["summary"]["objects"]["_n_results"] == 2
    # List columns split on ":" so they facet and free-text search per value.
    assert "spreadsheet" in contribution["summary"]["_all"]["data_types"]
    assert "graphs" in contribution["summary"]["_all"]["data_types"]
    # ERDA longitudes are -180/180, unlike MagIC's 0-360.
    assert contribution["summary"]["_all"]["_geo_point"] == [{"lat": -14.2122, "lon": -169.0573}]


def test_erda_facets_are_summarized_columns(erda_node):
    """Every configured facet must be a real column, or its bucket is always empty."""
    model = erda_node.load_data_model(erda_node.data_model.latest)
    columns = {c for table in model["tables"].values() for c in table["columns"]}
    assert set(erda_node.search.facets) <= columns


# An OSU-MGR contribution: one cruise's holdings, spanning both hierarchy
# branches (a gravity core cut into sections, and a dredged rock) plus files.
OSU_MGR_TEXT = "\n>>>>>>>>>>\n".join(
    [
        _tab_block(
            "contribution",
            ["id", "version", "data_model_version"],
            [{"id": 42, "version": 1, "data_model_version": "1.0"}],
        ),
        _tab_block(
            "cruises",
            [
                "cruise",
                "osu_id",
                "cruise_name",
                "collection",
                "rv_name",
                "pi",
                "pi_institution",
                "accession_date",
                "moratorium",
                "methods",
                "materials",
            ],
            [
                {
                    "cruise": "SR2113",
                    "osu_id": "OSU-SR2113",
                    "cruise_name": "2021 Cascadia Margin Coring",
                    "collection": "MGG Holdings",
                    "rv_name": "R/V Sally Ride",
                    "pi": "@hstaudigel",
                    "pi_institution": "Oregon State University",
                    "accession_date": "2022-03-14",
                    "moratorium": "f",
                    "methods": "Gravity Core:Dredge",
                    "materials": "Sediment:Rock",
                }
            ],
        ),
        _tab_block(
            "cores",
            [
                "core",
                "cruise",
                "osu_id",
                "core_number",
                "core_type",
                "method",
                "material",
                "length",
                "lat",
                "lon",
                "water_depth",
                "start_date",
            ],
            [
                {
                    "core": "SR2113-17GC",
                    "cruise": "SR2113",
                    "osu_id": "OSU-SR2113-17GC",
                    "core_number": 17,
                    "core_type": "GC",
                    "method": "Gravity Core",
                    "material": "Sediment",
                    "length": 412,
                    "lat": 44.6368,
                    "lon": -124.9012,
                    "water_depth": 2840,
                    "start_date": "2021-08-14",
                }
            ],
        ),
        _tab_block(
            "sections",
            ["section", "core", "osu_id", "section_number", "depth_top", "depth_bottom", "length"],
            [
                {
                    "section": "SR2113-17GC-1",
                    "core": "SR2113-17GC",
                    "osu_id": "OSU-SR2113-17GC-1",
                    "section_number": 1,
                    "depth_top": 0,
                    "depth_bottom": 150,
                    "length": 150,
                },
                {
                    "section": "SR2113-17GC-2",
                    "core": "SR2113-17GC",
                    "osu_id": "OSU-SR2113-17GC-2",
                    "section_number": 2,
                    "depth_top": 150,
                    "depth_bottom": 300,
                    "length": 150,
                },
            ],
        ),
        _tab_block(
            "section_halves",
            ["section_half", "section", "osu_id", "half_type", "igsn", "sesar_resource_type"],
            [
                {
                    "section_half": "SR2113-17GC-1A",
                    "section": "SR2113-17GC-1",
                    "osu_id": "OSU-SR2113-17GC-1A",
                    "half_type": "Archive",
                    "igsn": "OSU-SR2113-17GC-1A",
                    "sesar_resource_type": "Core Half Round",
                }
            ],
        ),
        _tab_block(
            "dives",
            [
                "dive",
                "cruise",
                "osu_id",
                "dive_number",
                "method",
                "material",
                "lat",
                "lon",
                "water_depth",
            ],
            [
                {
                    "dive": "SR2113-D1",
                    "cruise": "SR2113",
                    "osu_id": "OSU-SR2113-D1",
                    "dive_number": 1,
                    "method": "Dredge",
                    "material": "Rock",
                    "lat": 44.9,
                    "lon": -130.2,
                    "water_depth": 2200,
                }
            ],
        ),
        _tab_block(
            "dive_samples",
            ["dive_sample", "dive", "osu_id", "igsn", "material", "texture", "weight"],
            [
                {
                    "dive_sample": "SR2113-D1-1",
                    "dive": "SR2113-D1",
                    "osu_id": "OSU-SR2113-D1-1",
                    "igsn": "OSU-SR2113-D1-1",
                    "material": "Rock",
                    "texture": "Basalt",
                    "weight": 3.4,
                }
            ],
        ),
        _tab_block(
            "files",
            ["file", "file_type", "osu_id", "level", "media_type", "size_bytes"],
            [
                {
                    "file": "Collection/Holdings/SR2113/mstdata/OSU-SR2113-17GC-1A-mstdata.csv",
                    "file_type": "mst-data",
                    "osu_id": "OSU-SR2113-17GC-1A",
                    "level": "section_halves",
                    "media_type": "text/csv",
                    "size_bytes": 918273,
                },
                {
                    "file": "Collection/Holdings/SR2113/cruisereport/OSU-SR2113-cruisereport.pdf",
                    "file_type": "cruise-report",
                    "osu_id": "OSU-SR2113",
                    "level": "cruises",
                    "media_type": "application/pdf",
                    "size_bytes": 4021994,
                },
            ],
        ),
    ]
)


def test_osu_mgr_config_loads(osu_mgr_node):
    assert osu_mgr_node.hierarchy[:3] == ["contribution", "cruises", "cores"]
    assert osu_mgr_node.hierarchy[-1] == "files"
    # The index must not collide with the repository pipeline's own `osu-mgr` alias.
    assert osu_mgr_node.search.index == "osumgr"


def test_osu_mgr_validate_accepts_good_contribution(osu_mgr_node):
    report = validate_contribution(osu_mgr_node, parse_text(OSU_MGR_TEXT))
    assert report.errors == []


def test_osu_mgr_validate_controlled_vocabularies(osu_mgr_node):
    bad = OSU_MGR_TEXT.replace("mst-data", "mst-datum")
    bad = bad.replace("Gravity Core:Dredge", "Gravity Core:Trebuchet")
    report = validate_contribution(osu_mgr_node, parse_text(bad))
    messages = " | ".join(e.message for e in report.errors)
    assert "mst-datum" in messages
    assert "Trebuchet" in messages


def test_osu_mgr_summarize_both_branches(osu_mgr_node):
    meta = {"id": 42, "version": 1, "_is_activated": True, "_is_latest": True}
    docs = summarize(osu_mgr_node, parse_text(OSU_MGR_TEXT), meta)
    by_type = {}
    for doc in docs:
        by_type.setdefault(doc["type"], []).append(doc)
    assert len(by_type["sections"]) == 2
    assert len(by_type["dive_samples"]) == 1
    assert len(by_type["files"]) == 2

    contribution = by_type["contribution"][0]
    all_values = contribution["summary"]["_all"]
    # Both branches roll up into the same contribution document.
    assert "Gravity Core" in all_values["method"]
    assert "Dredge" in all_values["method"]
    assert "mst-data" in all_values["file_type"]
    # Every row's position is on it, the core's among them; longitudes stay -180/180.
    assert {"lat": 44.6368, "lon": -124.9012} in all_values["_geo_point"]


def test_osu_mgr_facets_are_summarized_columns(osu_mgr_node):
    model = osu_mgr_node.load_data_model(osu_mgr_node.data_model.latest)
    columns = {c for table in model["tables"].values() for c in table["columns"]}
    assert set(osu_mgr_node.search.facets) <= columns


def test_osu_mgr_extra_types_are_hierarchy_tables(osu_mgr_node):
    """Levels searchable without a tab still need documents to search."""
    assert set(osu_mgr_node.search.extra_types) <= set(osu_mgr_node.hierarchy)


def test_search_body_sort_options():
    from fiesta.search.queries import DEFAULT_SORT, SORT_OPTIONS, build_search_body

    # Default: newest first without free text, relevance with it.
    body = build_search_body(table="contribution", query=None)
    assert body["sort"] == SORT_OPTIONS[DEFAULT_SORT]
    # Totals are exact, not capped at OpenSearch's default 10,000.
    assert body["track_total_hits"] is True
    body = build_search_body(table="contribution", query="basalt")
    assert body["sort"] == SORT_OPTIONS["relevance"]
    # A token-only query has no free text, so it still sorts newest first.
    body = build_search_body(table="contribution", query='id:"1"')
    assert body["sort"] == SORT_OPTIONS["recent"]
    # Explicit option wins; every option is a valid, non-empty sort list.
    assert build_search_body(table="sites", query="basalt", sort="id_desc")["sort"] == [
        {"summary.contribution.id": {"order": "desc", "unmapped_type": "long"}}
    ]
    for name, clauses in SORT_OPTIONS.items():
        assert clauses, name
        for clause in clauses:
            if clause != "_score":
                (spec,) = clause.values()
                assert "unmapped_type" in spec, name


def test_magic_home_config(magic_node):
    home = magic_node.features.home
    assert len(home.resources) == 9
    for card in home.resources:
        assert (card.to is None) != (card.href is None)
    assert home.news and all(item.html for item in home.news)
    # Referenced local images exist under config/magic/assets and resolve safely.
    for item in home.news:
        if item.image and not item.image.startswith("http"):
            assert magic_node.asset_path(item.image) is not None, item.image
    assert magic_node.asset_path("../magic.yaml") is None
    assert "home" in magic_node.public_config()["features"]


# ---- deployment: one API process, every node ---------------------------------


def test_deployment_lists_every_node_and_resolves_key_or_slug():
    deployment = load_deployment(CONFIG_DIR / "fiesta.yaml")
    assert [n.node.slug for n in deployment.node_list] == [
        "magic",
        "kdd",
        "cdr",
        "karar",
        "erda",
        "osu-mgr",
    ]
    assert deployment.node_for("MagIC") is deployment.node_for("magic")
    assert deployment.node_for("OSU-MGR").node.slug == "osu-mgr"
    with pytest.raises(KeyError):
        deployment.node_for("nope")


def test_deployment_narrowed_by_fiesta_node():
    narrowed = load_deployment(CONFIG_DIR / "fiesta.yaml", only=["magic", " KArAr", ""])
    assert sorted(narrowed.nodes) == ["karar", "magic"]
    everything = load_deployment(CONFIG_DIR / "fiesta.yaml", only=[""])
    assert len(everything.nodes) == 6
    with pytest.raises(ValueError, match="nope"):
        load_deployment(CONFIG_DIR / "fiesta.yaml", only=["nope"])


def test_api_mounts_every_node_router_once_under_v2(monkeypatch):
    from fiesta.nodeconfig import get_deployment
    from fiesta.settings import get_settings

    monkeypatch.setenv("FIESTA_CONFIG_FILE", str(CONFIG_DIR / "fiesta.yaml"))
    monkeypatch.delenv("FIESTA_NODE", raising=False)
    get_settings.cache_clear()
    get_deployment.cache_clear()
    try:
        from fiesta.apps.api import create_app

        paths = create_app().openapi()["paths"]
    finally:
        get_settings.cache_clear()
        get_deployment.cache_clear()
    assert "/v2/health-check" in paths and "/v2/auth/login" in paths
    for route in (
        "/v2/{repository}/config",
        "/v2/{repository}/search/{table}",
        "/v2/{repository}/private/contributions",
        "/v2/{repository}/workspaces",
        "/v2/{repository}/contributions/{contribution_id}/download",
        "/v2/{repository}/plugins/poles/plate-boundaries",
        "/v2/{repository}/plugins/depth-plot/contributions/{contribution_id}/measurements",
        "/v2/admin/users",
        "/v2/admin/nodes/{slug}/publish",
    ):
        assert route in paths, route
    assert not [p for p in paths if p.startswith("/api")]


# ---- node configuration revisions (fiesta.services.node_config) -------------


def test_node_tree_round_trips_and_validates():
    from fiesta.services import node_config as svc

    files = svc.read_tree(CONFIG_DIR, "karar")
    assert "karar.yaml" in files and "karar/data_models/1.0.json" in files
    manifest = {p: svc.sha256(c) for p, c in files.items()}
    assert svc.tree_hash(manifest) == svc.tree_hash(dict(reversed(manifest.items())))
    node = svc.validate_files("karar", files, key="KArAr")
    assert node.node.key == "KArAr"

    with pytest.raises(svc.ConfigError) as err:
        svc.validate_files("karar", files, key="KARAR")
    assert "node.key" in err.value.errors[0]
    broken = {**files, "karar/data_models/1.0.json": b"{not json"}
    with pytest.raises(svc.ConfigError, match="1.0.json"):
        svc.validate_files("karar", broken)
    missing_table = files["karar.yaml"].replace(b"  - measurements\n", b"  - nope\n", 1)
    with pytest.raises(svc.ConfigError, match="nope"):
        svc.validate_files("karar", {**files, "karar.yaml": missing_table})


def test_node_paths_stay_inside_the_node():
    from fiesta.services import node_config as svc

    assert svc.check_path("cdr", "cdr/data_models/1.0.json") == "cdr/data_models/1.0.json"
    assert svc.check_path("cdr", "cdr.yaml") == "cdr.yaml"
    for bad in ("magic.yaml", "cdr/../magic.yaml", "/etc/passwd", "cdr/", "cdr", "fiesta.yaml"):
        with pytest.raises(svc.ConfigError):
            svc.check_path("cdr", bad)
    with pytest.raises(svc.ConfigError):
        svc.check_identity("admin", "Admin")
    svc.check_identity("new-node", "NewNode")


def test_settings_patch_keeps_yaml_comments():
    import yaml

    from fiesta.services import node_config as svc

    original = (CONFIG_DIR / "karar.yaml").read_bytes()
    patched = svc.patch_yaml(
        original,
        [
            {"path": ["node", "title"], "value": "KArAr, renamed"},
            {"path": ["features", "pages"], "value": ["about"]},
            {"path": ["doi"], "value": None},
        ],
    )
    text = patched.decode()
    assert '"#3030bb" # Semantic UI "blue" in the legacy app' in text
    assert "# Legacy Meteor sources" in text
    loaded = yaml.safe_load(patched)
    assert loaded["node"]["title"] == "KArAr, renamed"
    assert loaded["features"]["pages"] == ["about"] and "doi" not in loaded
    assert svc.protected_changes(original, patched) == []
    moved = svc.patch_yaml(original, [{"path": ["search", "index"], "value": "other"}])
    assert svc.protected_changes(original, moved) == ["search.index"]
    hidden = svc.patch_yaml(original, [{"path": ["publish", "web"], "value": False}])
    assert svc.protected_changes(original, hidden) == ["publish"]


def test_publish_flags_gate_production_only(monkeypatch, magic_node, osu_mgr_node):
    from fastapi import HTTPException
    from starlette.requests import Request

    from fiesta.apps.deps import request_node
    from fiesta.nodeconfig import PublishConfig
    from fiesta.settings import get_settings

    assert magic_node.publish == PublishConfig()
    assert osu_mgr_node.publish == PublishConfig(api=True, web=False)
    with pytest.raises(ValueError, match="publish.web needs publish.api"):
        PublishConfig(api=False, web=True)

    def serves(environment, node):
        monkeypatch.setenv("FIESTA_ENVIRONMENT", environment)
        get_settings.cache_clear()
        try:
            return node.serves_api, node.serves_web, node.public_config()["web_published"]
        finally:
            get_settings.cache_clear()

    assert serves("production", osu_mgr_node) == (True, False, False)
    assert serves("development", osu_mgr_node) == (True, True, True)
    assert serves("production", magic_node) == (True, True, True)

    # An unpublished API is an unknown repository outside a local stack.
    closed = osu_mgr_node.model_copy(update={"publish": PublishConfig(api=False, web=False)})
    monkeypatch.setattr("fiesta.apps.deps.get_deployment", lambda: _OneNode(closed))
    request = Request({"type": "http", "path_params": {"repository": "osu-mgr"}})
    monkeypatch.setenv("FIESTA_ENVIRONMENT", "production")
    get_settings.cache_clear()
    try:
        with pytest.raises(HTTPException) as err:
            request_node(request)
        assert err.value.status_code == 404
        monkeypatch.setenv("FIESTA_ENVIRONMENT", "development")
        get_settings.cache_clear()
        assert request_node(request) is closed
    finally:
        get_settings.cache_clear()


class _OneNode:
    def __init__(self, node):
        self.node = node

    def node_for(self, _repository):
        return self.node


def test_new_node_from_a_template_is_valid():
    from fiesta.services import node_config as svc

    files = svc.read_tree(CONFIG_DIR, "magic")
    template = svc.validate_files("magic", files)
    new = svc.template_files(template, files, "paleo", "Paleo", "Paleo Data")
    node = svc.validate_files("paleo", new, key="Paleo")
    assert node.search.index == "paleo" and node.legacy is None
    assert node.data_model.versions == template.data_model.versions
    assert all(p == "paleo.yaml" or p.startswith("paleo/") for p in new)
    assert not [p for p in new if "/seeds/" in p or "/assets/" in p]


def test_pages_and_filters_are_node_configuration(magic_node):
    from fiesta.nodeconfig import SearchConfig
    from fiesta.services import node_config as svc

    # magic.yaml: pages in menu order, HTML files beside them, poles filters
    # scoped to the Locations level's Poles view.
    assert [p.slug for p in magic_node.pages][:2] == ["about", "technology"]
    assert magic_node.page("help").menu == "right"
    assert "Mission Statement" in magic_node.load_page_html("about")
    with pytest.raises(KeyError):
        magic_node.load_page_html("nope")
    public = magic_node.public_config()
    assert "pages" not in public["features"] and public["pages"][0]["slug"] == "about"
    assert public["facets"][0] == "method_codes"
    age = next(f for f in magic_node.search.filters if f.field == "summary.poles.age")
    assert (age.type, age.levels, age.views, age.scale) == ("range", ["Locations"], ["Poles"], 1e6)

    # The pre-2026-09 `facets:` list still loads, as facet filters.
    legacy = SearchConfig(index="x", levels=[], facets=["lithologies", "method_codes"])
    assert [f.type for f in legacy.filters] == ["facet", "facet"]
    assert legacy.facets == ["lithologies", "method_codes"]
    with pytest.raises(ValueError, match="summary"):
        SearchConfig(index="x", levels=[], filters=[{"type": "range", "field": "age"}])

    # validate_files: a page needs its HTML, a facet its column, a filter its level.
    files = svc.read_tree(CONFIG_DIR, "magic")
    yaml_text = files["magic.yaml"].decode()
    with_page = yaml_text.replace("pages:\n", "pages:\n  - { slug: news, title: News }\n", 1)
    with pytest.raises(svc.ConfigError, match="magic/pages/news.html is missing"):
        svc.validate_files("magic", {**files, "magic.yaml": with_page.encode()})
    ok = svc.validate_files(
        "magic", {**files, "magic.yaml": with_page.encode(), "magic/pages/news.html": b"<p>hi</p>"}
    )
    assert ok.page("news") is not None
    bad_facet = yaml_text.replace("field: method_codes", "field: no_such_column", 1)
    with pytest.raises(svc.ConfigError, match="no_such_column"):
        svc.validate_files("magic", {**files, "magic.yaml": bad_facet.encode()})
    bad_level = yaml_text.replace("levels: [Locations], views: [Poles] }", "levels: [Moons] }", 1)
    with pytest.raises(svc.ConfigError, match="Moons"):
        svc.validate_files("magic", {**files, "magic.yaml": bad_level.encode()})
    reserved = with_page.replace("slug: news", "slug: admin")
    with pytest.raises(svc.ConfigError, match="admin"):
        svc.validate_files("magic", {**files, "magic.yaml": reserved.encode()})


def test_published_tree_is_written_back_to_config(tmp_path, monkeypatch):
    import shutil

    from fiesta.services import node_config as svc
    from fiesta.services.node_publish import add_to_deployment_yaml, blob_sha, write_files
    from fiesta.settings import get_settings

    deployment_yaml = (CONFIG_DIR / "fiesta.yaml").read_text()
    assert add_to_deployment_yaml(deployment_yaml, "magic.yaml") is None
    added = add_to_deployment_yaml(deployment_yaml, "paleo.yaml")
    assert "    - osu-mgr.yaml\n    - paleo.yaml" in added and added.startswith("# FIESTA")
    assert blob_sha(b"hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"

    shutil.copy(CONFIG_DIR / "fiesta.yaml", tmp_path / "fiesta.yaml")
    shutil.copytree(CONFIG_DIR / "kdd", tmp_path / "kdd")
    shutil.copy(CONFIG_DIR / "kdd.yaml", tmp_path / "kdd.yaml")
    monkeypatch.setenv("FIESTA_CONFIG_FILE", str(tmp_path / "fiesta.yaml"))
    get_settings.cache_clear()
    try:
        files = svc.read_tree(tmp_path, "kdd")
        files["kdd/notes.md"] = b"new\n"
        dropped = next(p for p in files if p.startswith("kdd/seeds/"))
        del files[dropped]
        assert write_files(tmp_path, "kdd", files) == f"-{dropped}, kdd/notes.md"
        assert svc.read_tree(tmp_path, "kdd") == files
        assert write_files(tmp_path, "kdd", files) == "no changes"
    finally:
        get_settings.cache_clear()


def test_geo_tables_follow_the_data_model(magic_node, osu_mgr_node, karar_node):
    # Coordinates, or the key column of a table above with them (inherited).
    assert magic_node.geo_tables == set(magic_node.hierarchy)
    assert karar_node.geo_tables == set(karar_node.hierarchy)
    assert {"cruises", "cores", "sections", "dives"} <= osu_mgr_node.geo_tables
    assert "files" not in osu_mgr_node.geo_tables
    levels = {lvl["table"]: lvl["geo"] for lvl in magic_node.public_config()["search_levels"]}
    assert levels["sites"] and levels["specimens"]


def test_rows_without_coordinates_take_their_ancestors_position(magic_node):
    from fiesta.domain.parse import ParsedContribution

    parsed = ParsedContribution(
        tables={
            "locations": [
                {"location": "L", "lat_s": "10", "lat_n": "12", "lon_w": "359", "lon_e": "1"}
            ],
            "sites": [{"site": "S", "location": "L", "lat": "11", "lon": "0.5"}],
            "samples": [{"sample": "A", "site": "S"}, {"sample": "B", "site": "unknown"}],
            "specimens": [{"specimen": "a1", "sample": "A"}],
        }
    )
    docs = summarize(magic_node, parsed, {"id": 1})
    geo = {
        (d["type"], next(iter(d["summary"][d["type"]].values()))): d["summary"]["_all"].get(
            "_geo_point"
        )
        for d in docs
        if d["type"] != "contribution"
    }
    # A box's position is its middle, across the antimeridian.
    assert geo[("locations", "L")] == {"lat": 11.0, "lon": 0.0}
    assert geo[("samples", "A")] == {"lat": 11.0, "lon": 0.5}
    assert geo[("specimens", "a1")] == {"lat": 11.0, "lon": 0.5}
    # An unknown parent inherits nothing.
    assert geo[("samples", "B")] is None
    contribution = next(d for d in docs if d["type"] == "contribution")
    # The contribution carries each distinct own position once.
    assert contribution["summary"]["_all"]["_geo_point"] == [
        {"lat": 11.0, "lon": 0.0},
        {"lat": 11.0, "lon": 0.5},
    ]


def test_map_points_from_a_search_doc():
    from fiesta.apps.routers.search import _map_points

    site = {
        "summary": {
            "contribution": {"id": 7},
            "sites": {"site": "S1"},
            "_all": {"_geo_point": {"lat": 10.5, "lon": -20}},
        }
    }
    assert _map_points(site, "sites") == [{"id": 7, "lat": 10.5, "lon": -20.0, "name": "S1"}]
    location = {
        "summary": {
            "contribution": {"id": 8},
            "locations": {
                "location": "L",
                "lat_s": "1",
                "lat_n": "2",
                "lon_w": "350",
                "lon_e": "10",
            },
            "_all": {"_geo_point": {"lat": 1, "lon": -10}},
        }
    }
    assert _map_points(location, "locations")[0]["bounds"] == [350.0, 1.0, 10.0, 2.0]
    assert _map_points({"summary": {"_all": {}}}, "sites") == []
    # A contribution's points; with an area, only those inside it (across 180°).
    contribution = {
        "summary": {
            "contribution": {"id": 9},
            "_all": {"_geo_point": [{"lat": 0, "lon": 179}, {"lat": 0, "lon": 10}]},
        }
    }
    assert len(_map_points(contribution, "contribution")) == 2
    inside = _map_points(contribution, "contribution", (170, -5, -170, 5))
    assert [p["lon"] for p in inside] == [179.0]
    # Points on another body carry it, and an area (on Earth) leaves them out.
    contribution["summary"]["_all"]["_body_point"] = [{"lat": 1, "lon": 23, "body": "moon"}]
    assert _map_points(contribution, "contribution")[-1] == {
        "id": 9,
        "lat": 1.0,
        "lon": 23.0,
        "body": "moon",
    }
    assert len(_map_points(contribution, "contribution", (170, -5, -170, 5))) == 1


def test_map_colors_are_node_configuration(magic_node):
    """magic.yaml's map colors: a column is offered on the levels whose table
    has it, a summary.* path on every level with positions; a record's value
    is its text parsed, an age in years BP by its unit."""
    from fiesta.apps.routers.search import _location_point, _map_points
    from fiesta.nodeconfig import MapColor

    public = {c["field"]: c for c in magic_node.public_config()["map_colors"]}
    assert public["vadm"]["tables"] == ["sites"]
    assert "contribution" in public["summary.contribution._reference.year"]["tables"]
    assert "unit_factors" not in public["age"]
    assert magic_node.map_color("sites", "age") is not None
    assert magic_node.map_color("samples", "age") is None
    with pytest.raises(ValueError, match="summary"):
        MapColor(label="x", field="sites.age")
    with pytest.raises(ValueError, match="unit_factors"):
        MapColor(label="x", field="age", unit_column="age_unit")
    from fiesta.services import node_config as svc

    files = svc.read_tree(CONFIG_DIR, "magic")
    bad = files["magic.yaml"].decode().replace("field: vadm,", "field: no_such_column,", 1)
    with pytest.raises(svc.ConfigError, match="no_such_column"):
        svc.validate_files("magic", {**files, "magic.yaml": bad.encode()})

    age = magic_node.map_color("sites", "age")

    def site(value, unit):
        return {
            "summary": {
                "contribution": {"id": 7},
                "sites": {"site": "S1", "age": value, "age_unit": unit},
                "_all": {"_geo_point": {"lat": 1, "lon": 2}},
            }
        }

    def value(doc):
        return _map_points(doc, "sites", None, age)[0].get("value")

    assert value(site("1.5", "Ma")) == 1.5e6
    assert value(site("1900", "Years AD (+/-)")) == 50
    assert value(site("1.5", "Eons")) is None
    assert value(site("n/a", "Ma")) is None
    year = magic_node.map_color("sites", "summary.contribution._reference.year")
    doc = site("1", "Ma")
    doc["summary"]["contribution"]["_reference"] = {"year": 2014}
    assert _map_points(doc, "sites", None, year)[0]["value"] == 2014
    # A location's records' mean, from the composite bucket's avg.
    bucket = {
        "key": {"contribution": 7},
        "doc_count": 3,
        "at": {"location": {"lat": 1, "lon": 2}},
        "value": {"value": 12.5},
    }
    assert _location_point(bucket)["value"] == 12.5
    assert "value" not in _location_point({**bucket, "value": {"value": None}})


def test_undersea_features_for_the_map_labels():
    from fiesta.apps.routers.basemap import undersea_features

    ring = [[179, 10], [-179, 10], [-179, 12], [179, 12], [179, 10]]
    collection = undersea_features(
        [
            (
                "point",
                [
                    {
                        "properties": {"NAME": "Axial", "TYPE": "Seamount"},
                        "geometry": {"type": "Point", "coordinates": [-130, 46]},
                    }
                ],
            ),
            (
                "line",
                [
                    {
                        "properties": {"NAME": "Gorda Ridge", "TYPE": "Ridge"},
                        "geometry": {"type": "LineString", "coordinates": [[-127, 41], [-126, 43]]},
                    }
                ],
            ),
            (
                "area",
                [
                    {
                        "properties": {"NAME": "Wide", "TYPE": "Basin"},
                        "geometry": {"type": "Polygon", "coordinates": [ring]},
                    }
                ],
            ),
            (
                "area",
                [
                    {
                        "properties": {"NAME": "", "TYPE": "Basin"},
                        "geometry": {"type": "Polygon", "coordinates": [ring]},
                    }
                ],
            ),
        ]
    )
    names = [(f["properties"]["name"], f["properties"]["kind"]) for f in collection["features"]]
    assert names == [("Axial Seamount", "point"), ("Gorda Ridge", "line"), ("Wide Basin", "area")]
    # An area across the antimeridian is labelled on it, not on the far side.
    lon, lat = collection["features"][2]["geometry"]["coordinates"]
    assert abs(abs(lon) - 179.4) < 0.5 and lat == 10.8


def test_search_scoped_to_one_contribution(monkeypatch):
    """`?contribution=` (the contribution modal): any version of that one
    contribution once its visibility is checked, not the latest-and-public
    filters of a search."""
    import asyncio

    from fiesta.apps.routers import search as router
    from fiesta.search.queries import build_search_body

    checked = []

    async def visible(session, node, contribution_id, private_key):
        checked.append((contribution_id, private_key))

    monkeypatch.setattr(router, "_get_visible_contribution", visible)
    body = build_search_body(table="sites", query="basalt")
    asyncio.run(router._constrain(None, None, body, "basalt", 16901, "key"))
    filters = body["query"]["bool"]["filter"]
    assert checked == [(16901, "key")]
    assert {"term": {"summary.contribution.id": 16901}} in filters
    assert not any("_is_latest" in str(f) or "_is_activated" in str(f) for f in filters)
    assert {"term": {"type": "sites"}} in filters


def test_facet_buckets_count_rows_and_mapped():
    """A facet value carries its rows and positioned docs besides its docs, so
    the sidebar counts follow the Summaries, Rows and Map sub-tabs."""
    from fiesta.apps.routers.search import _facet_bucket
    from fiesta.search.queries import build_search_body

    body = build_search_body(
        table="sites", query=None, facets=["lithologies"], count_field="summary.sites._n_results"
    )
    assert body["aggs"]["lithologies"]["aggs"]["count"]["sum"]["missing"] == 1
    bucket = {"key": "Basalt", "doc_count": 3, "count": {"value": 12.0}, "mapped": {"doc_count": 2}}
    assert _facet_bucket(bucket) == {
        "key": "Basalt",
        "doc_count": 3,
        "rows_count": 12,
        "mapped_count": 2,
    }
    # An index that never held the count field: one row per doc.
    unsummed = {"key": "Basalt", "doc_count": 3, "count": {"value": 0}}
    assert _facet_bucket(unsummed)["rows_count"] == 3
    assert _facet_bucket({"key": "Basalt", "doc_count": 3}) == {"key": "Basalt", "doc_count": 3}


def test_large_maps_are_unique_locations(magic_node, monkeypatch):
    """Past MAP_DOCS_LIMIT records, a level of points maps as its unique
    locations per contribution (a composite aggregation), paged to the cap."""
    import asyncio

    from fiesta.apps.routers import search as router

    assert router._has_boxes(magic_node, "locations")
    assert not router._has_boxes(magic_node, "sites")

    pages = [
        [
            {
                "key": {"tile": "24/1/1", "contribution": 7},
                "doc_count": 40,
                "at": {"location": {"lat": 88.5, "lon": 10.0}},
            },
            {"key": {"tile": "24/1/2", "contribution": 8}, "doc_count": 1, "at": {}},
        ],
        [],
    ]
    requests = []

    class Client:
        async def search(self, index, body):
            requests.append(body["aggs"]["locations"]["composite"].get("after"))
            buckets = pages[len(requests) - 1]
            return {"aggregations": {"locations": {"buckets": buckets, "after_key": {"x": 1}}}}

    monkeypatch.setattr(router, "MAP_PAGE_SIZE", 2)
    points, truncated = asyncio.run(router._location_points(Client(), "i", {"match_all": {}}))
    # The centroid is exact, even past Web Mercator's limit; no centroid, no point.
    assert points == [{"id": 7, "lat": 88.5, "lon": 10.0, "count": 40}]
    assert not truncated
    assert requests == [None, {"x": 1}]


def test_reference_metadata_in_the_legacy_shape():
    """A reference DOI's Crossref (or DataCite) record becomes the legacy
    `_reference`; a fetch's outcome decides when the DOI is fetched again."""
    import asyncio
    from datetime import UTC, datetime

    import httpx

    from fiesta.db.models import DoiReference
    from fiesta.services import references as refs
    from fiesta.services.contributions import contribution_meta

    assert refs.normalize("https://doi.org/10.1029/2019gc008479.") == "10.1029/2019GC008479"
    assert refs.normalize("doi:10.7288/V4/MAGIC/16757") == "10.7288/V4/MAGIC/16757"
    assert refs.normalize("This Study") is None

    crossref = {
        "DOI": "10.1029/2019gc008479",
        "title": ["Paleomagnetism of the Golan Heights"],
        "container-title": ["Geochemistry, Geophysics, Geosystems"],
        "published-online": {"date-parts": [[2019, 9]]},
        "issued": {"date-parts": [[2018]]},
        "volume": "20",
        "issue": "11",
        "page": "4948-4960",
        "is-referenced-by-count": 29,
        "author": [
            {"given": "Nicole", "family": "BEHAR", "ORCID": "https://orcid.org/0000-0002-6374-2277"},
            {"given": "Ron", "family": "Shaar", "affiliation": [{"name": "Hebrew University"}]},
            {"given": "Lisa", "family": "Tauxe"},
        ],
    }
    ref = refs.from_crossref(crossref)
    assert (ref["source"], ref["doi"], ref["year"]) == ("crossref", "10.1029/2019GC008479", 2019)
    assert ref["citation"] == "Behar et al. (2019)"
    assert ref["authors"][0] == {
        "family": "Behar",
        "_name": "N. Behar",
        "given": "Nicole",
        "_orcid": "0000-0002-6374-2277",
    }
    assert ref["authors"][1]["affiliation"] == ["Hebrew University"]
    assert ref["long_authors"] == "Nicole Behar, Ron Shaar, Lisa Tauxe"
    assert ref["n_citations"] == 29
    assert ref["long_citation"] == (
        "Nicole Behar, Ron Shaar, Lisa Tauxe (2019). Paleomagnetism of the Golan Heights. "
        "Geochemistry, Geophysics, Geosystems 20 (11):4948-4960. doi:10.1029/2019GC008479."
    )
    assert "<b>" in ref["html"] and '"' not in ref["html"]

    datacite = {
        "doi": "10.7288/v4/magic/16757",
        "titles": [{"title": "A MagIC dataset"}],
        "publisher": {"name": "Magnetics Information Consortium (MagIC)"},
        "publicationYear": 2020,
        "creators": [
            {
                "name": "Tauxe, Lisa",
                "nameIdentifiers": [
                    {"nameIdentifier": "0000-0002-4837-8200", "nameIdentifierScheme": "ORCID"}
                ],
            },
            {"name": "EarthRef.org", "nameType": "Organizational"},
        ],
    }
    ref = refs.from_datacite(datacite)
    assert (ref["journal"], ref["year"], ref["citation"]) == (
        "Magnetics Information Consortium (MagIC)",
        2020,
        "Tauxe & EarthRef.org (2020)",
    )
    assert ref["authors"][0]["_orcid"] == "0000-0002-4837-8200"

    # A fetch's outcome: fetched again in a month; an error retries sooner,
    # and a failed refresh keeps the metadata it had.
    row = DoiReference(doi="10.1029/2019GC008479", status="pending", attempts=0)
    assert asyncio.run(refs._apply(row, ("ok", "crossref", crossref)))
    assert row.status == "ok" and row.reference["year"] == 2019
    assert row.due_at - row.fetched_at == refs.REFRESH
    assert not asyncio.run(refs._apply(row, ("ok", "crossref", crossref)))  # unchanged
    assert not asyncio.run(refs._apply(row, httpx.ConnectError("down")))
    assert row.status == "ok" and "ConnectError" in row.error
    assert row.due_at - datetime.now(UTC) <= refs.RETRY
    missing = DoiReference(doi="10.9999/X", status="pending", attempts=0)
    assert not asyncio.run(refs._apply(missing, ("not_found", None, None)))
    assert missing.status == "not_found"

    # Indexing: the cached metadata, or just the DOI before it is fetched.
    class Row:
        id = version = contributor_id = 1
        activated_at = updated_at = datetime.now(UTC)
        data_model_version = "3.0"
        private_key = "k"
        is_activated = is_latest = True
        reference_doi = "10.1029/2019gc008479"
        previous_id = None

    class Person:
        id, name = 1, "L. Tauxe"

    assert contribution_meta(Row(), Person())["_reference"] == {"doi": "10.1029/2019gc008479"}
    assert contribution_meta(Row(), Person(), row.reference)["_reference"]["year"] == 2019
