import pytest

from fiesta.domain.parse import ParseError, export_text, parse_text
from fiesta.domain.summarize import summarize
from fiesta.domain.validate import guess_data_model_version, validate_contribution

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


def test_guess_version(magic_node):
    assert guess_data_model_version(magic_node, parse_text(MAGIC_TEXT)) == "3.0"


def test_validate_accepts_good_contribution(magic_node):
    report = validate_contribution(magic_node, parse_text(MAGIC_TEXT))
    assert report.errors == []


def test_validate_flags_bad_column_value_and_table(magic_node):
    bad = MAGIC_TEXT + """>>>>>>>>>>
tab delimited\tsites
site\tlocation\tlat\tnot_a_real_column
HW03\tHawaii\tnot-a-number\tx
>>>>>>>>>>
tab delimited\tnot_a_table
foo
bar
"""
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
            [{"id": 155, "version": 1, "data_model_version": "1.0",
              "reference": "10.1029/2003GC000626"}],
        ),
        _tab_block(
            "objects",
            ["object", "title", "data_types", "expert_level", "keywords",
             "computer_program", "project", "project_group", "continents_oceans",
             "countries", "locations", "lat", "lon", "age_high", "age_low",
             "age_unit", "timescale_epoch", "license"],
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
                    "lat": -14.2122, "lon": -169.0573,
                    "age_high": 1, "age_low": 0, "age_unit": "Ma",
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
                {"file": "df2000.cmb.zip", "object": "df2000-hydrocast",
                 "format": "zip", "media_type": "application/zip",
                 "size_bytes": 2306867},
                {"file": "garnet.peridotite.xenoliths.xls",
                 "object": "garnet-peridotite-xenoliths", "format": "xls",
                 "media_type": "application/vnd.ms-excel", "size_bytes": 503808},
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
    assert contribution["summary"]["_all"]["_geo_point"] == {"lat": -14.2122, "lon": -169.0573}


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
            ["cruise", "osu_id", "cruise_name", "collection", "rv_name", "pi",
             "pi_institution", "accession_date", "moratorium", "methods", "materials"],
            [{
                "cruise": "SR2113", "osu_id": "OSU-SR2113",
                "cruise_name": "2021 Cascadia Margin Coring",
                "collection": "MGG Holdings", "rv_name": "R/V Sally Ride",
                "pi": "@hstaudigel", "pi_institution": "Oregon State University",
                "accession_date": "2022-03-14", "moratorium": "f",
                "methods": "Gravity Core:Dredge", "materials": "Sediment:Rock",
            }],
        ),
        _tab_block(
            "cores",
            ["core", "cruise", "osu_id", "core_number", "core_type", "method",
             "material", "length", "lat", "lon", "water_depth", "start_date"],
            [{
                "core": "SR2113-17GC", "cruise": "SR2113", "osu_id": "OSU-SR2113-17GC",
                "core_number": 17, "core_type": "GC", "method": "Gravity Core",
                "material": "Sediment", "length": 412, "lat": 44.6368,
                "lon": -124.9012, "water_depth": 2840, "start_date": "2021-08-14",
            }],
        ),
        _tab_block(
            "sections",
            ["section", "core", "osu_id", "section_number", "depth_top",
             "depth_bottom", "length"],
            [
                {"section": "SR2113-17GC-1", "core": "SR2113-17GC",
                 "osu_id": "OSU-SR2113-17GC-1", "section_number": 1,
                 "depth_top": 0, "depth_bottom": 150, "length": 150},
                {"section": "SR2113-17GC-2", "core": "SR2113-17GC",
                 "osu_id": "OSU-SR2113-17GC-2", "section_number": 2,
                 "depth_top": 150, "depth_bottom": 300, "length": 150},
            ],
        ),
        _tab_block(
            "section_halves",
            ["section_half", "section", "osu_id", "half_type", "igsn",
             "sesar_resource_type"],
            [{"section_half": "SR2113-17GC-1A", "section": "SR2113-17GC-1",
              "osu_id": "OSU-SR2113-17GC-1A", "half_type": "Archive",
              "igsn": "OSU-SR2113-17GC-1A", "sesar_resource_type": "Core Half Round"}],
        ),
        _tab_block(
            "dives",
            ["dive", "cruise", "osu_id", "dive_number", "method", "material",
             "lat", "lon", "water_depth"],
            [{"dive": "SR2113-D1", "cruise": "SR2113", "osu_id": "OSU-SR2113-D1",
              "dive_number": 1, "method": "Dredge", "material": "Rock",
              "lat": 44.9, "lon": -130.2, "water_depth": 2200}],
        ),
        _tab_block(
            "dive_samples",
            ["dive_sample", "dive", "osu_id", "igsn", "material", "texture", "weight"],
            [{"dive_sample": "SR2113-D1-1", "dive": "SR2113-D1",
              "osu_id": "OSU-SR2113-D1-1", "igsn": "OSU-SR2113-D1-1",
              "material": "Rock", "texture": "Basalt", "weight": 3.4}],
        ),
        _tab_block(
            "files",
            ["file", "file_type", "osu_id", "level", "media_type", "size_bytes"],
            [
                {"file": "Collection/Holdings/SR2113/mstdata/OSU-SR2113-17GC-1A-mstdata.csv",
                 "file_type": "mst-data", "osu_id": "OSU-SR2113-17GC-1A",
                 "level": "section_halves", "media_type": "text/csv",
                 "size_bytes": 918273},
                {"file": "Collection/Holdings/SR2113/cruisereport/OSU-SR2113-cruisereport.pdf",
                 "file_type": "cruise-report", "osu_id": "OSU-SR2113",
                 "level": "cruises", "media_type": "application/pdf",
                 "size_bytes": 4021994},
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
    # The first geo point comes from the core; longitudes stay -180/180.
    assert all_values["_geo_point"] == {"lat": 44.6368, "lon": -124.9012}


def test_osu_mgr_facets_are_summarized_columns(osu_mgr_node):
    model = osu_mgr_node.load_data_model(osu_mgr_node.data_model.latest)
    columns = {c for table in model["tables"].values() for c in table["columns"]}
    assert set(osu_mgr_node.search.facets) <= columns


def test_osu_mgr_extra_types_are_hierarchy_tables(osu_mgr_node):
    """Levels searchable without a tab still need documents to search."""
    assert set(osu_mgr_node.search.extra_types) <= set(osu_mgr_node.hierarchy)
