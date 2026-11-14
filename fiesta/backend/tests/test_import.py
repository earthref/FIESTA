"""The upload page's import step: value normalisation, the table merge for an
upload into an existing contribution, and the node's upload options."""

import pytest
from pydantic import ValidationError

from fiesta.domain.importer import (
    correct_term,
    levenshtein,
    merge,
    normalise,
    normalise_value,
    single_source_errors,
)
from fiesta.domain.parse import ParsedContribution, block_tables, export_text, parse_text
from fiesta.domain.validate import Validator, validate_contribution
from fiesta.nodeconfig import ExcelTemplate
from fiesta.services.imports import original_names

CLASSES = ["Extrusive", "Igneous", "Not Specified", "Sedimentary"]


def vocab(name):
    return {"class": CLASSES, "boolean": ["True", "False"], "quality": ["b", "g"]}.get(name)


def test_levenshtein():
    assert levenshtein("kitten", "sitting") == 3
    assert levenshtein("", "abc") == 3
    assert levenshtein("same", "same") == 0


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("igneous", "Igneous"),  # case
        ("IGNEOUS", "Igneous"),
        ("Igneuos", "Igneuos"),  # a transposition is two edits: left for validation
        ("Igneus", "Igneous"),  # one letter missing
        ("Sedimentery", "Sedimentary"),  # one letter wrong
        ("Volcanic", "Volcanic"),  # not close: left for validation
    ],
)
def test_correct_term(value, expected):
    assert correct_term(value, CLASSES) == expected


def test_correct_term_leaves_short_and_ambiguous_values():
    assert correct_term("x", ["b", "g"]) == "x"  # every one-letter term is one edit away
    assert correct_term("G", ["b", "g"]) == "g"  # case still corrects
    assert correct_term("cat", ["bat", "hat"]) == "cat"  # two terms equally close


@pytest.mark.parametrize(
    ("value", "expected"),
    [("t", "True"), ("1", "True"), ("TRUE", "True"), ("f", "False"), ("0", "False"), ("x", "x")],
)
def test_boolean_terms(value, expected):
    assert correct_term(value, ["True", "False"]) == expected


def test_normalise_value():
    integer = {"type": "Integer"}
    assert normalise_value(integer, "3.0", vocab) == "3"
    assert normalise_value(integer, "3.00 ", vocab) == "3"
    assert normalise_value(integer, "3.5", vocab) == "3.5"  # a real error stays for validation
    assert normalise_value({"type": "Number"}, "3.0", vocab) == "3.0"
    classes = {"type": "List", "validations": ['cv("class")']}
    assert normalise_value(classes, ":extrusive:IGNEOUS:", vocab) == ":Extrusive:Igneous:"
    assert normalise_value(classes, "Igneus:Sedimentery", vocab) == "Igneous:Sedimentary"
    flag = {"type": "String", "validations": ['cv("boolean")']}
    assert normalise_value(flag, "t", vocab) == "True"
    unknown = {"type": "String", "validations": ['cv("nope")']}
    assert normalise_value(unknown, "anything", vocab) == "anything"


def test_normalise_against_the_magic_model(magic_node):
    model = magic_node.load_data_model(magic_node.data_model.latest)
    parsed = ParsedContribution(
        tables={
            "sites": [{"site": "s1", "geologic_classes": "igneous", "dir_n_samples": "4.0"}],
            "unknown": [{"x": "1.0"}],
        }
    )
    terms = Validator(magic_node).vocabulary_terms
    out = normalise(parsed, model, terms)
    assert out.tables["sites"] == [
        {"site": "s1", "geologic_classes": "Igneous", "dir_n_samples": "4"}
    ]
    assert out.tables["unknown"] == [{"x": "1.0"}]


def test_single_source_tables():
    text = (
        "tab delimited\tmeasurements\nmeasurement\nm1\n>>>>>>>>>>\n"
        "tab delimited\tsites\nsite\ns1\n>>>>>>>>>>\n"
        "tab delimited\tmeasurements\nmeasurement\nm2\n"
    )
    assert block_tables(text) == ["measurements", "sites", "measurements"]
    assert single_source_errors(block_tables(text), ["measurements"]) == [
        "There is more than one measurements table in this upload. "
        "Please combine them before uploading."
    ]
    assert single_source_errors(block_tables(text), ["sites"]) == []
    # Other tables may come from several sheets: their rows are combined.
    assert [r["measurement"] for r in parse_text(text).tables["measurements"]] == ["m1", "m2"]


def test_merge_replaces_only_the_uploaded_tables():
    existing = ParsedContribution(
        tables={
            "contribution": [{"lab_names": "Lab A", "reference": "10.1/x", "description": "old"}],
            "sites": [{"site": "old"}],
            "samples": [{"sample": "keep"}],
        }
    )
    imported = ParsedContribution(
        tables={
            "contribution": [{"description": "new", "lab_names": ""}],
            "sites": [{"site": "a"}, {"site": "b"}],
            "specimens": [{"specimen": "new"}],
        }
    )
    merged = merge(
        existing,
        imported,
        keep_table="contribution",
        keep_columns=["lab_names", "reference", "description"],
    )
    assert merged.tables["sites"] == [{"site": "a"}, {"site": "b"}]
    assert merged.tables["samples"] == [{"sample": "keep"}]
    assert merged.tables["specimens"] == [{"specimen": "new"}]
    # The workspace fields survive where the upload leaves them blank.
    assert merged.tables["contribution"] == [
        {"description": "new", "lab_names": "Lab A", "reference": "10.1/x"}
    ]
    assert existing.tables["sites"] == [{"site": "old"}], "the inputs are not modified"


def test_merge_into_a_new_contribution():
    imported = ParsedContribution(tables={"sites": [{"site": "a"}]})
    merged = merge(ParsedContribution(), imported, keep_table="contribution", keep_columns=["x"])
    assert merged.tables == {"sites": [{"site": "a"}]}


def test_magic_examples_import_cleanly(magic_node):
    """The MagIC text example round-trips through the import path and stays
    valid; the CSV example's rows survive as a specimens table."""
    model = magic_node.load_data_model(magic_node.data_model.latest)
    terms = Validator(magic_node).vocabulary_terms
    raw = magic_node.asset_path("examples/magic-text-3.0.txt").read_text()
    parsed = normalise(parse_text(raw), model, terms)
    text = export_text(merge(ParsedContribution(), parsed), model)
    again = parse_text(text)
    assert set(again.tables) == set(parse_text(raw).tables)
    assert (
        validate_contribution(magic_node, again).is_valid
        == validate_contribution(magic_node, parse_text(raw)).is_valid
    )


def test_magic_upload_options(magic_node):
    upload = magic_node.upload
    assert upload.single_source_tables == ["measurements"]
    assert {e.format for e in upload.examples} == {"fiesta", "tsv", "csv", "excel"}
    assert all(magic_node.asset_path(e.file) for e in upload.examples)
    template = upload.excel_templates[0]
    assert (template.skip_rows, template.skip_columns) == (3, 1)
    assert magic_node.public_config()["upload"]["excel_templates"][0]["markers"] == {
        "A1": "Group:",
        "A4": "Column:",
    }


@pytest.mark.parametrize("markers", [{}, {"a1": "x"}, {"A0": "x"}, {"A1": "("}])
def test_excel_template_markers_are_checked(markers):
    with pytest.raises(ValidationError):
        ExcelTemplate(markers=markers)


def test_original_names():
    kept = original_names(
        {"sites.xlsx": b"x", "magic_contribution_1.txt": b"y"}, "magic_contribution_1.txt"
    )
    assert kept == {"sites.xlsx": b"x", "original-magic_contribution_1.txt": b"y"}
