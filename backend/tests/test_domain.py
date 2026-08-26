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
