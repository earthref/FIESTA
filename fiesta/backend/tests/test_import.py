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
from fiesta.domain.parse import (
    ParsedContribution,
    block_tables,
    export_text,
    parse_text,
    table_row_counts,
)
from fiesta.domain.validate import Validator, validate_contribution
from fiesta.nodeconfig import ExcelTemplate
from fiesta.services.attachments import block_rows, cards, references, refusal, upload_meta
from fiesta.services.imports import original_names, upload_files
from fiesta.services.thumbnails import thumbnail

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
    assert table_row_counts(text) == {
        table: len(rows) for table, rows in parse_text(text).tables.items()
    }
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


def test_older_uploads_are_upgraded(magic_node):
    """A whole-contribution upload in an older data model is saved upgraded,
    with the original and the upgrade report as attachments (C3); the 2.5
    example the upload page offers is one."""
    canonical = "magic_contribution_1.txt"
    example = next(e for e in magic_node.upload.examples if e.file.endswith("2.5.txt"))
    raw = magic_node.asset_path(example.file).read_bytes()
    files = upload_files(magic_node, raw, "magic-text-2.5.txt", canonical)
    assert set(files) == {canonical, "magic-text-2.5.txt", "upgrade-report.txt"}
    assert files["magic-text-2.5.txt"] == raw
    upgraded = parse_text(files[canonical].decode())
    assert upgraded.tables["contribution"][0]["data_model_version"] == "3.0"
    assert "er_sites" not in upgraded.tables and len(upgraded.tables["sites"]) == 24
    assert files["upgrade-report.txt"].startswith(b"Upgraded from data model version 2.5 to 3.0")
    # Latest-version text, and text that does not parse, are saved as they are.
    current = magic_node.asset_path("examples/magic-text-3.0.txt").read_bytes()
    assert upload_files(magic_node, current, "x.txt", canonical) == {canonical: current}
    assert upload_files(magic_node, b"nonsense", "x.txt", canonical) == {canonical: b"nonsense"}


def test_original_names():
    kept = original_names(
        {"sites.xlsx": b"x", "magic_contribution_1.txt": b"y"}, "magic_contribution_1.txt"
    )
    assert kept == {"sites.xlsx": b"x", "original-magic_contribution_1.txt": b"y"}


def test_upload_originals_record_their_rows(magic_node):
    """Each block of the upload page's import text is counted against the
    file it came from; a whole-file upload's original brought every row."""
    text = (
        "tab\tsites\nsite\tlat\ns1\t1\ns2\t2\n>>>>>>>>>>\n"
        "tab\tsamples\nsample\tsite\nx1\ts1\n>>>>>>>>>>\n"
        "tab\tsites\nsite\ns3\n"
    )
    rows = block_rows(text, ["a.xlsx", "b.csv", "a.xlsx"])
    assert rows == {"a.xlsx": {"sites": 3}, "b.csv": {"samples": 1}}
    assert block_rows(text, ["a.xlsx"]) == {}
    canonical = "magic_contribution_1.txt"
    example = next(e for e in magic_node.upload.examples if e.file.endswith("2.5.txt"))
    files = upload_files(
        magic_node, magic_node.asset_path(example.file).read_bytes(), "old.txt", canonical
    )
    meta = upload_meta(files, canonical)
    assert meta["upgrade-report.txt"] == {"origin": "upload", "rows": {}}
    assert meta["old.txt"]["origin"] == "upload" and meta["old.txt"]["rows"]["sites"] == 24


def test_attachment_references_and_locks():
    text = (
        "tab\tcontribution\nid\tdescription\n1\tsee Fig1.PNG\n>>>>>>>>>>\n"
        "tab\tsites\nsite\timage\tnotes\n"
        "s1\thttps://x.org/files/fig1.png\tfig1.png\n"
        "s2\tfig1.png.bak\t\n"
        "s3\tplots:notes.pdf\t\n"
        "s4\tmyfig1.png\t\n"
    )
    refs = references(text, ["fig1.png", "notes.pdf", "unused.txt"])
    assert refs == {
        "fig1.png": {"contribution": 1, "sites": 1},
        "notes.pdf": {"sites": 1},
        "unused.txt": {},
    }
    snapshot = {
        "canonical": "c.txt",
        "files": {
            n: {"size": 1, "sha256": "x"} for n in ["c.txt", "fig1.png", "unused.txt", "a.xlsx"]
        },
        "attachments": {
            "a.xlsx": {"origin": "upload", "rows": {"sites": 4}, "added_at": "t"},
            "unused.txt": {"origin": "attachment", "added_at": "t"},
        },
    }
    out = {c["name"]: c for c in cards(snapshot, text)}
    assert set(out) == {"fig1.png", "unused.txt", "a.xlsx"}
    assert out["a.xlsx"]["rows"] == {"sites": 4} and "upload tool" in out["a.xlsx"]["locked"]
    assert out["fig1.png"]["origin"] is None and out["fig1.png"]["locked"].startswith("2 rows")
    assert out["fig1.png"]["kind"] == "image" and out["a.xlsx"]["kind"] == "spreadsheet"
    assert out["unused.txt"]["locked"] is None
    assert refusal({"origin": None, "referenced": {"sites": 1}}).startswith("1 row ")


def test_thumbnails():
    import io

    import pypdfium2 as pdfium
    from PIL import Image

    raw = io.BytesIO()
    Image.new("I;16", (1200, 600), 40000).save(raw, "TIFF")
    image = Image.open(io.BytesIO(thumbnail(raw.getvalue(), "image")))
    assert image.format == "WEBP" and image.size == (320, 160)
    pdf = pdfium.PdfDocument.new()
    pdf.new_page(612, 792)
    out = io.BytesIO()
    pdf.save(out)
    image = Image.open(io.BytesIO(thumbnail(out.getvalue(), "pdf")))
    assert max(image.size) == 320
    assert thumbnail(b"not an image", "image") is None
    assert thumbnail(raw.getvalue(), "text") is None
