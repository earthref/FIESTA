"""The validator's DSL (fiesta.domain.validate), with the legacy MagIC
validate_contribution.tests.js cases ported where FIESTA keeps their meaning."""

import json
import re

import pytest
from _paths import CONFIG_DIR

from fiesta.domain.parse import ParsedContribution, parse_text
from fiesta.domain.summarize import summarize
from fiesta.domain.validate import Validator, cell_values, significant_digits
from fiesta.nodeconfig import load_deployment

CONTRIBUTION = {"data_model_version": "3.0", "reference": "10.1029/93JB00024"}


def _report(node, tables: dict, model: dict | None = None):
    validator = Validator(node)
    if model is not None:
        validator.model = model
    return validator.validate(ParsedContribution(tables=tables))


def _messages(issues, table=None, column=None) -> list[str]:
    return [
        i.message
        for i in issues
        if (table is None or i.table == table) and (column is None or i.column == column)
    ]


def _has(issues, table, column, pattern) -> bool:
    return any(re.search(pattern, m) for m in _messages(issues, table, column))


# ---- legacy: field types ---------------------------------------------------------


@pytest.mark.parametrize("value", ["01", "9 ", "+1", " -2"])
def test_integer_accepts(magic_node, value):
    report = _report(magic_node, {"locations": [{"dir_n_sites": value}]})
    assert not _has(report.errors, "locations", "dir_n_sites", "integer")


@pytest.mark.parametrize("value", ["1.", "a1", " 2* ", "1e5", "-"])
def test_integer_rejects(magic_node, value):
    report = _report(magic_node, {"locations": [{"dir_n_sites": value}]})
    assert _has(report.errors, "locations", "dir_n_sites", "expected an integer")


# Legacy also accepted "1e5.2" (a decimal exponent); Python's float does not.
@pytest.mark.parametrize("value", ["1.", "01", "9 ", "+1", " -2", "1e5", "1.52e-1"])
def test_number_accepts(magic_node, value):
    report = _report(magic_node, {"locations": [{"age": value}]})
    assert not _has(report.errors, "locations", "age", "expected a number")


@pytest.mark.parametrize("value", ["a1", " 2* ", "a", "1-2", "1..2", "1.2.2", "1.2,2"])
def test_number_rejects(magic_node, value):
    report = _report(magic_node, {"locations": [{"age": value}]})
    assert _has(report.errors, "locations", "age", "expected a number")


@pytest.mark.parametrize(
    "value",
    [
        "2013-02-08",
        "20130208",
        "2013-02-08T09",
        "2013-02-08 09:30:26.123",
        "2013-02-08 09+07:00",
        "2013-02-08 09Z",
        "2013-02-08 09:30:26.123+07:00",
    ],
)
def test_timestamp_accepts(magic_node, value):
    report = _report(magic_node, {"samples": [{"timestamp": value}]})
    assert not _has(report.errors, "samples", "timestamp", "timestamp")


@pytest.mark.parametrize("value", ["2013-13-08", "a", ":", "Invalid date"])
def test_timestamp_rejects(magic_node, value):
    report = _report(magic_node, {"samples": [{"timestamp": value}]})
    assert _has(report.errors, "samples", "timestamp", "expected an ISO 8601 timestamp")


# ---- legacy: invalid contributions ------------------------------------------------


def test_missing_required_field(magic_node):
    report = _report(magic_node, {"locations": [{"location": "location name"}]})
    assert _messages(report.errors, "locations", "location_type") == [
        "missing required value for 'location_type'"
    ]


def test_missing_required_if_field(magic_node):
    report = _report(
        magic_node,
        {"locations": [{"location": "l", "age_sigma": "0", "age_low": "1", "age_high": "2"}]},
    )
    assert _messages(report.errors, "locations", "age") == [
        "missing required value for 'age' since 'age_sigma' has a value"
    ]


def test_missing_required_one_in_group_field(magic_node):
    report = _report(magic_node, {"ages": [{"age": "0"}]})
    assert _messages(report.errors, "ages", "location") == [
        "missing a value in one of 'location', 'site', 'sample' and 'specimen' (group 'Names')"
    ]
    # One issue per row, not one per column of the group.
    assert not _messages(report.errors, "ages", "site")
    named = _report(magic_node, {"ages": [{"age": "0", "specimen": "s"}]})
    assert not _has(named.errors, "ages", None, "one of")


def test_missing_required_unless_field(magic_node):
    report = _report(magic_node, {"locations": [{"location": "location name"}]})
    assert _messages(report.errors, "locations", "age") == [
        "missing required value for 'age' since 'age_low' and 'age_high' are empty"
    ]
    # age_low and age_high name age back: the blank row is reported once.
    assert not _messages(report.errors, "locations", "age_low")
    assert not _messages(report.errors, "locations", "age_high")
    bounded = _report(
        magic_node, {"locations": [{"location": "l", "age_low": "1", "age_high": "2"}]}
    )
    assert not _messages(bounded.errors, "locations", "age")


def test_missing_required_unless_table_field(magic_node):
    report = _report(magic_node, {"locations": [{"location": "location name"}]})
    assert _messages(report.errors, "locations", "citations") == [
        "missing required value for 'citations' since there is no 'sites' table"
    ]
    with_sites = _report(
        magic_node,
        {"locations": [{"location": "l"}], "sites": [{"site": "s", "location": "l"}]},
    )
    assert not _messages(with_sites.errors, "locations", "citations")


def test_value_not_in_controlled_vocabulary(magic_node):
    report = _report(magic_node, {"locations": [{"age_unit": "?"}]})
    assert _messages(report.errors, "locations", "age_unit") == [
        "'?' is not in the controlled vocabulary 'age_unit'"
    ]


def test_unknown_method_code(magic_node):
    """type("method_codes") is checked against the method-codes plugin's list
    (case-insensitively, as cv("method_codes") is)."""
    report = _report(magic_node, {"locations": [{"method_codes": "LP-PI:lp-dc3:?"}]})
    assert _messages(report.errors, "locations", "method_codes") == [
        "'?' is not in the controlled vocabulary 'method_codes'"
    ]


@pytest.mark.parametrize(("value", "message"), [("-91", "below the minimum"), ("91", "above")])
def test_value_out_of_range(magic_node, value, message):
    report = _report(magic_node, {"locations": [{"lat_s": value}]})
    assert _has(report.errors, "locations", "lat_s", message)


def test_missing_parent_keys(magic_node):
    """A required in() column whose table is missing is one error naming the
    table (legacy: one per row, MagIC #454)."""
    report = _report(magic_node, {"sites": [{"location": "a"}, {"location": "b"}]})
    assert _messages(report.errors, "sites", "location") == [
        "there is no locations table: each sites row names a location from it in "
        "'location', so add a locations table with a row for each location"
    ]
    present = _report(magic_node, {"locations": [{"location": "b"}], "sites": [{"location": "a"}]})
    assert _messages(present.errors, "sites", "location") == [
        "'a' is not a location in the locations table"
    ]


def test_missing_child_keys(magic_node):
    """An optional list of child names checks each name when the child table
    is there; without it, one warning (legacy: an error per row)."""
    report = _report(
        magic_node,
        {"sites": [{"site": "s", "samples": "a:b"}], "samples": [{"sample": "a"}]},
    )
    assert _messages(report.errors, "sites", "samples") == [
        "'b' is not a sample in the samples table"
    ]
    missing = _report(magic_node, {"sites": [{"site": "s", "samples": "a"}]})
    assert not _messages(missing.errors, "sites", "samples")
    assert _messages(missing.warnings, "sites", "samples") == [
        "'samples' names rows of the samples table, but there is no samples table"
    ]


def test_missing_experiment_keys(magic_node):
    report = _report(
        magic_node,
        {
            "sites": [{"site": "s", "experiments": "e1:e2"}],
            "measurements": [{"experiment": "e1"}],
        },
    )
    assert _messages(report.errors, "sites", "experiments") == [
        "'e2' is not an experiment in the measurements table"
    ]


# ---- legacy: a valid natural contribution -------------------------------------------


def test_natural_data_has_no_errors(magic_node):
    tables = {
        "contribution": [
            {**CONTRIBUTION, "lab_names": "Paleomagnetic Laboratory (AGICO Inc., Czech Republic)"}
        ],
        "locations": [
            {
                "location": "location 1",
                "sites": "site 1",
                "location_type": "Archeological Ashes",
                "geologic_classes": "Archeologic",
                "lithologies": ":Achondrite:Agate:",
                "lat_s": "0",
                "lat_n": "0",
                "lon_w": "0",
                "lon_e": "0",
                "age": "0",
                "age_unit": "Ma",
            }
        ],
        "sites": [
            {
                "location": "location 1",
                "site": "site 1",
                "result_quality": "g",
                "result_type": "a",
                "method_codes": ":LP-PI",
                "citations": "This study",
                "geologic_classes": "Archeologic",
                "geologic_types": "Amphora",
                "lithologies": ":Achondrite:Agate:",
                "lat": "0",
                "lon": "0",
                "age": "0",
                "age_unit": "Ma",
            }
        ],
        "samples": [
            {
                "site": "site 1",
                "sample": "sample 1",
                "specimens": "specimen 1:specimen 2:",
                "result_quality": "g",
                "result_type": "a",
                "method_codes": ":LP-PI",
                "citations": "This study",
            }
        ],
        "specimens": [
            {
                "sample": "sample 1",
                "specimen": f"specimen {n}",
                "experiments": f"experiment {n}",
                "result_quality": "g",
                "method_codes": ":LP-PI",
                "citations": "This study",
            }
            for n in (1, 2)
        ],
        "measurements": [
            {
                "measurement": f"measurement {n}",
                "experiment": f"experiment {n}",
                "specimen": f"specimen {n}",
                "sequence": str(n),
                "standard": "s",
                "quality": "g",
                "method_codes": "LP-PI",
                "citations": "This study",
            }
            for n in (1, 2)
        ],
    }
    report = _report(magic_node, tables)
    assert report.errors == []


# ---- MagIC #564: requiredIfGroup per row ---------------------------------------------

GROUP_MODEL = {
    "tables": {
        "sites": {
            "columns": {
                "site": {"type": "String"},
                "dir_dec": {
                    "type": "Number",
                    "group": "Direction",
                    "validations": ['requiredIfGroup("Direction")'],
                },
                "dir_inc": {
                    "type": "Number",
                    "group": "Direction",
                    "validations": ['requiredIfGroup("Direction")'],
                },
                "dir_n": {"type": "Integer", "group": "Direction"},
            }
        }
    }
}


def test_required_if_group_checks_each_row(magic_node):
    report = _report(
        magic_node,
        {
            "sites": [
                {"site": "a", "dir_inc": "10"},
                {"site": "b"},
                {"site": "c", "dir_dec": "1", "dir_inc": "2"},
            ]
        },
        GROUP_MODEL,
    )
    assert [(i.row, i.column, i.message) for i in report.errors] == [
        (
            1,
            "dir_dec",
            "missing required value for 'dir_dec' since group 'Direction' has values ('dir_inc')",
        )
    ]


# ---- MagIC #590: recommended() never fails --------------------------------------------


def test_empty_recommended_column_only_warns(magic_node):
    text = (CONFIG_DIR / "magic" / "seeds" / "valid.txt").read_text()
    report = Validator(magic_node).validate(parse_text(text))
    assert report.is_valid
    assert "recommended column 'result_quality' has no values" in _messages(
        report.warnings, "sites", "result_quality"
    )
    # A recommended column blank in some rows is neither an error nor a warning.
    parsed = parse_text(text)
    parsed.tables["sites"][0]["result_quality"] = "g"
    report = Validator(magic_node).validate(parsed)
    assert report.is_valid
    assert not _messages(report.errors + report.warnings, "sites", "result_quality")


# ---- MagIC #453, #363: capitalisation is rejected with the right spelling ------------


def test_vocabulary_case_is_rejected_with_the_spelling(magic_node):
    report = _report(magic_node, {"locations": [{"location_type": "region"}]})
    assert _messages(report.errors, "locations", "location_type") == [
        "'region' is not in the controlled vocabulary 'location_type'; it is spelled 'Region'"
    ]


def test_column_and_table_case_is_rejected_with_the_spelling(magic_node):
    report = _report(
        magic_node,
        {"sites": [{"site": "s", "int_rel_arm": "1", "Lat": "1"}], "Sites": [{"site": "t"}]},
    )
    assert (
        "unrecognized column 'int_rel_arm' in table 'sites'; the data model spells it 'int_rel_ARM'"
        in _messages(report.errors, "sites")
    )
    assert (
        "unrecognized column 'Lat' in table 'sites'; the data model spells it 'lat'"
        in _messages(report.errors, "sites")
    )
    assert _messages(report.errors, "Sites") == [
        "unrecognized table 'Sites'; the data model spells it 'sites'"
    ]


def test_unnamed_column_says_which(magic_node):
    parsed = parse_text("tab delimited\tsites\nsite\t\nS1\tx\n")
    report = Validator(magic_node).validate(parsed)
    assert _messages(report.errors, "sites", "_unnamed_2") == [
        "column 2 of table 'sites' has values but no name in the header row"
    ]


# ---- MagIC #485: integers too large for OpenSearch's long ---------------------------


def test_integer_beyond_a_long_is_an_error(magic_node):
    report = _report(magic_node, {"sites": [{"dir_n_samples": "368482598770000000000"}]})
    assert _messages(report.errors, "sites", "dir_n_samples") == [
        "368482598770000000000 is too large for an integer column (at most 19 digits)"
    ]
    largest = _report(magic_node, {"sites": [{"dir_n_samples": str(2**63 - 1)}]})
    assert not _messages(largest.errors, "sites", "dir_n_samples")


def test_large_whole_number_in_a_number_column_indexes_as_a_double(magic_node):
    """A Number column's huge whole number (vadm_sigma 368482598770000000000)
    validates, and its search doc holds it as a float, which the index maps
    as double (summary._num), so it cannot overflow a long mapping."""
    tables = {"sites": [{"site": "s", "vadm_sigma": "368482598770000000000"}]}
    assert not _messages(_report(magic_node, tables).errors, "sites", "vadm_sigma")
    docs = summarize(magic_node, ParsedContribution(tables=tables), {"id": 1})
    numbers = [
        d["summary"]["_num"]["vadm_sigma"]
        for d in docs
        if "vadm_sigma" in d["summary"].get("_num", {})
    ]
    assert numbers and all(isinstance(v, float) for values in numbers for v in values)
    json.dumps(docs, allow_nan=False)


# ---- MagIC #423, #454, #491: missing tables and the reference -----------------------


def test_missing_locations_table_is_one_actionable_error(magic_node):
    sites = [{"site": f"s{n}", "location": "l"} for n in range(50)]
    report = _report(magic_node, {"sites": sites})
    about_locations = [i for i in report.errors if "locations table" in i.message]
    assert len(about_locations) == 1
    assert about_locations[0].row is None


def test_required_column_missing_from_the_table_is_one_error(magic_node):
    rows = [{"measurement": f"m{n}", "specimen": "s"} for n in range(100)]
    report = _report(magic_node, {"measurements": rows})
    assert _messages(report.errors, "measurements", "experiment") == [
        "the measurements table has no 'experiment' column, which is required in every row"
    ]


def test_blank_reference_says_to_enter_the_doi(magic_node):
    report = _report(magic_node, {"contribution": [{"data_model_version": "3.0"}]})
    assert _messages(report.errors, "contribution", "reference") == [
        "the contribution has no reference DOI: enter the DOI of the publication these "
        "data come from in the contribution's Reference field"
    ]


def test_workspace_table_has_one_row(magic_node):
    report = _report(magic_node, {"contribution": [CONTRIBUTION, CONTRIBUTION]})
    assert _messages(report.errors, "contribution", None)[-1:] == [
        "the contribution table has 2 rows; it must have exactly one"
    ]


# ---- MagIC #127, #133: significant digits --------------------------------------------


@pytest.mark.parametrize(
    ("value", "flagged"),
    [
        ("0.30000000000000004", True),
        ("-6.4839999999999995e-09", True),
        ("12.3000000001", True),
        ("4.1999999999998", True),
        ("19.5", False),
        ("2000000000", False),
        ("0.000123456789", False),
        ("1.23456789012345", False),
    ],
)
def test_significant_digits(value, flagged):
    assert bool(significant_digits(value)) is flagged


def test_spreadsheet_artefacts_warn_without_changing_data(magic_node):
    rows = [{"site": f"s{n}", "lat": "19.300000000000001"} for n in range(150)]
    parsed = ParsedContribution(tables={"sites": rows})
    report = Validator(magic_node).validate(parsed)
    lat = _messages(report.warnings, "sites", "lat")
    assert lat[0] == (
        "19.300000000000001 has 17 significant digits, likely a spreadsheet rounding "
        "artefact; round it to the precision measured (e.g. 19.3)"
    )
    assert len(lat) == 101
    assert lat[-1] == "50 more values in 'lat' have implausibly many significant digits"
    assert not _messages(report.errors, "sites", "lat")
    assert parsed.tables["sites"][0]["lat"] == "19.300000000000001"


# ---- list, dictionary and matrix cells ------------------------------------------------


def test_cell_values():
    assert cell_values({"type": "List"}, ':a:"b:c":d:') == ["a", '"b:c"', "d"]
    assert cell_values({"type": "Dictionary"}, "GEOMAGIA50[1435]:CALS7K.2[23]") == [
        "GEOMAGIA50",
        "CALS7K.2",
    ]
    assert cell_values({"type": "Matrix"}, "DD:20:124;TP:45:14") == ["DD", "TP"]


def test_dictionary_keys_are_checked_against_the_vocabulary(magic_node):
    good = _report(
        magic_node, {"sites": [{"external_database_ids": "GEOMAGIA50[1435]:CALS7K.2[]"}]}
    )
    assert not _messages(good.errors, "sites", "external_database_ids")
    bad = _report(magic_node, {"sites": [{"external_database_ids": "NOPE[1]"}]})
    assert _messages(bad.errors, "sites", "external_database_ids") == [
        "'NOPE' is not in the controlled vocabulary 'external_database_names'"
    ]


def test_matrix_shape(magic_node):
    good = _report(magic_node, {"sites": [{"rotation_sequence": "DD:20:124;TP:45:14"}]})
    assert not _messages(good.errors, "sites", "rotation_sequence")
    bad = _report(magic_node, {"sites": [{"rotation_sequence": "DD:20:124;TP:45"}]})
    assert _messages(bad.errors, "sites", "rotation_sequence") == [
        "matrix row 2 has 2 values separated by ':'; expected 3"
    ]


def test_format_types_warn(magic_node):
    report = _report(magic_node, {"locations": [{"expedition_url": "earthref.org"}]})
    assert _messages(report.warnings, "locations", "expedition_url") == [
        "'earthref.org' does not look like a URL (https://...)"
    ]
    assert not report.errors or not _messages(report.errors, "locations", "expedition_url")
    model = {"tables": {"t": {"columns": {"doi": {"validations": ['type("doi")']}}}}}
    assert _report(magic_node, {"t": [{"doi": "10.1029/93JB00024"}]}, model).warnings == []
    assert (
        _report(magic_node, {"t": [{"doi": "https://doi.org/10.1029/93JB00024"}]}, model).warnings
        == []
    )
    assert _messages(_report(magic_node, {"t": [{"doi": "93JB00024"}]}, model).warnings) == [
        "'93JB00024' does not look like a DOI (10.xxxx/...)"
    ]


# ---- rules no legacy validator implemented ------------------------------------------


def test_required_if_column_value_warns(karar_node):
    report = _report(
        karar_node,
        {"experiments": [{"experiment": "e", "age_calculation_method": "Plateau"}]},
    )
    assert (
        "missing required value for '40ar_36ar_trapped' since 'age_calculation_method' is 'Plateau'"
        in _messages(report.warnings, "experiments", "40ar_36ar_trapped")
    )
    assert not _messages(report.errors, "experiments", "40ar_36ar_trapped")
    isochron = _report(
        karar_node,
        {"experiments": [{"experiment": "e", "age_calculation_method": "Normal Isochron"}]},
    )
    assert not _has(isochron.warnings, "experiments", "40ar_36ar_trapped", "since")
    assert _has(isochron.warnings, "experiments", "40ar_36ar_ratio", "is 'Normal Isochron'")


def test_required_unless_group_warns(magic_node):
    natural = _report(magic_node, {"samples": [{"sample": "a"}]})
    assert _messages(natural.warnings, "samples", "lat") == [
        "missing required value for 'lat' since no column of group 'Synthetic' has a value"
    ]
    assert not _messages(natural.errors, "samples", "lat")
    synthetic = _report(magic_node, {"samples": [{"sample": "a", "material_type": "Magnetite"}]})
    assert not _messages(synthetic.warnings, "samples", "lat")


def test_rules_the_data_cannot_decide():
    """requiredUnless<X>() and requiredOneInGroup("g") name a group or column
    their table lacks: not enforced, and listed here so a data model change
    that resolves (or adds) one is noticed."""
    unresolved = set()
    for node in load_deployment(CONFIG_DIR / "fiesta.yaml").nodes.values():
        validator = Validator(node)
        tables = {
            table: [{column: "x" for column in table_def["columns"]}]
            for table, table_def in validator.model["tables"].items()
        }
        validator.validate(ParsedContribution(tables=tables))
        validator.validate(ParsedContribution(tables={t: [{}] for t in tables}))
        unresolved |= {(node.node.slug, rule) for _, _, rule in validator.unresolved}
    assert unresolved == {
        ("cdr", "requiredOneInGroup(Names)"),
        ("karar", "requiredUnlessLegacy"),
        ("magic", "requiredUnlessNatural"),
    }
