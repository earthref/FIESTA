"""The MagIC 2.5 -> 3.0 upgrade step, with the core engine over MagIC's models.

`legacy_cases.json` is the legacy MagIC upgrade_contribution.tests.js 2.5 ->
3.0 suite, case for case (inputs, expected tables, message patterns); a case
whose expectation was changed says why in its `changed` field. The tests
below it pin the legacy bugs this port fixes and the whole-file upgrades.
"""

import json
import re
from pathlib import Path

import pytest

from fiesta.domain.parse import ParsedContribution, parse_text
from fiesta.domain.upgrade import UpgradeOptions
from fiesta.domain.validate import validate_contribution
from fiesta.plugins import active_plugins, all_plugins
from fiesta.services.upgrades import upgrade_parsed, upgrade_steps, upgraded_text

HERE = Path(__file__).parent
CASES = json.loads((HERE / "legacy_cases.json").read_text())
EXAMPLE = HERE.parents[1] / "magic" / "assets" / "examples" / "magic-text-2.5.txt"
PLUGIN = "magic-3-upgrade"


def _upgrade(node, tables, **options):
    result = upgrade_parsed(node, ParsedContribution(tables=tables), UpgradeOptions(**options))
    assert result is not None, "expected an older version"
    return result


def _messages(notes):
    return [n.message for n in notes]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_legacy_case(magic_node, case):
    result = _upgrade(magic_node, case["old"])
    errors = _messages(result.report.errors)
    if case["kind"] == "json":
        assert errors == []
        assert result.parsed.tables == case["expected"]
    elif case["kind"] == "n_errors":
        assert len(errors) == case["n"], errors
    else:
        pool = errors if case["kind"] == "error" else _messages(result.report.warnings)
        assert any(re.search(case["pattern"], m, re.I) for m in pool), pool


def test_plugin_supplies_the_step(magic_node):
    assert all_plugins()[PLUGIN] in active_plugins(magic_node)
    assert set(upgrade_steps(magic_node)) == {("2.5", "3.0")}


def test_options_are_checked(magic_node):
    plugin = all_plugins()[PLUGIN]
    with pytest.raises(ValueError, match="not one of"):
        plugin.check(magic_node, plugin.Options(from_version="1.0"))
    with pytest.raises(ValueError, match="must follow"):
        plugin.check(magic_node, plugin.Options(from_version="2.4"))


# -- legacy bugs, fixed ---------------------------------------------------------


def test_blank_polarity_and_nrm_origin_stay_blank(magic_node):
    """MagIC #295, #296, #374: the legacy upgrade wrote dir_polarity "n" and
    dir_nrm_origin "p" into every direction without one."""
    tables = {
        "contribution": [{"magic_version": "2.5"}],
        "pmag_sites": [{"er_site_name": "A", "site_dec": "10", "site_flag": "g"}],
    }
    site = _upgrade(magic_node, tables).parsed.tables["sites"][0]
    assert "dir_polarity" not in site and "dir_nrm_origin" not in site
    report = _upgrade(magic_node, tables).report
    offered = {d["key"]: d for d in report.defaults}
    assert offered["dir_polarity"]["on"] is False and offered["dir_polarity"]["count"] == 1
    # ... unless the contributor converts the blanks to the 2.5 defaults.
    opted = _upgrade(magic_node, tables, defaults={"dir_polarity": True, "dir_nrm_origin": True})
    assert opted.parsed.tables["sites"][0] | {} == {
        "site": "A",
        "dir_dec": "10",
        "result_quality": "g",
        "dir_polarity": "n",
        "dir_nrm_origin": "p",
        "method_codes": "DE-BFL",
    }


def test_explicit_polarity_is_kept(magic_node):
    tables = {
        "contribution": [{"magic_version": "2.5"}],
        "pmag_sites": [{"er_site_name": "A", "site_dec": "10", "site_polarity": "r"}],
    }
    assert _upgrade(magic_node, tables).parsed.tables["sites"][0]["dir_polarity"] == "r"


def test_blank_defaults_can_be_switched_off(magic_node):
    """MagIC #521: each 2.5 default is the contributor's choice."""
    tables = {
        "contribution": [{"magic_version": "2.5"}],
        "pmag_specimens": [{"er_specimen_name": "s1", "specimen_int": "1e-5"}],
    }
    on = _upgrade(magic_node, tables).parsed.tables["specimens"][0]
    assert on["result_quality"] == "g" and on["int_corr"] == "u"
    off = _upgrade(magic_node, tables, defaults={"result_quality": False, "int_corr": False})
    assert off.parsed.tables["specimens"][0] == {"specimen": "s1", "int_abs": "1e-5"}


def test_blank_tilt_correction_stays_blank(magic_node):
    """MagIC #521: a tilt-corrected direction without a tilt correction is
    accepted blank; -3 (unknown) only on request."""
    tables = {
        "contribution": [{"magic_version": "2.5"}],
        "pmag_results": [{"er_site_names": "A", "tilt_dec_corr": "2", "data_type": "i"}],
    }
    assert "dir_tilt_correction" not in _upgrade(magic_node, tables).parsed.tables["sites"][0]
    opted = _upgrade(magic_node, tables, defaults={"dir_tilt_correction": True})
    assert opted.parsed.tables["sites"][0]["dir_tilt_correction"] == "-3"


def test_measurements_get_sequence_and_treatment_steps(magic_node):
    """MagIC #374: 3.0's sequence is the measurement order; small integer
    2.5 measurement numbers become treatment step indexes and the
    measurement name is made unique with the experiment name."""
    rows = [
        {"er_specimen_name": "s1", "magic_experiment_name": "s1-AF", "measurement_number": "1"},
        {"er_specimen_name": "s1", "magic_experiment_name": "s1-AF", "measurement_number": "2"},
        {"er_specimen_name": "s1", "magic_experiment_name": "s1-T", "measurement_number": "1"},
        {"er_specimen_name": "s1", "magic_experiment_name": "s1-T", "measurement_number": "s1-T-x"},
    ]
    tables = {"contribution": [{"magic_version": "2.5"}], "magic_measurements": rows}
    measurements = _upgrade(magic_node, tables).parsed.tables["measurements"]
    assert [m["sequence"] for m in measurements] == ["1", "2", "3", "4"]
    assert [m["measurement"] for m in measurements] == ["s1-AF-1", "s1-AF-2", "s1-T-1", "s1-T-x"]
    assert [m.get("treat_step_num") for m in measurements] == ["1", "2", "1", None]
    assert {m["quality"] for m in measurements} == {"g"}


def test_values_a_level_cannot_hold_are_reported(magic_node):
    """MagIC #342: 3.0 has no specimen VGPs; the legacy upgrade dropped them
    without a word."""
    tables = {
        "contribution": [{"magic_version": "2.5"}],
        "pmag_results": [{"er_specimen_names": "s1", "vgp_lat": "80", "average_int": "1e-5"}],
    }
    report = _upgrade(magic_node, tables).report
    dropped = [n for n in report.warnings if n.kind == "dropped_value"]
    assert [(n.table, n.column) for n in dropped if n.column == "vgp_lat"] == [
        ("pmag_results", "vgp_lat")
    ]
    assert "specimens" in dropped[0].message


def test_dates_that_do_not_parse_are_kept(magic_node):
    """MagIC #374 ("Invalid date"): 24-hour times convert; a value that is not
    a 2.5 date is kept as written and reported; unknown zones are read as UTC
    with a warning."""
    rows = [
        {"er_specimen_name": "s1", "measurement_date": "2008:07:01:20:46:00.00"},
        {"er_specimen_name": "s1", "measurement_date": "July 1st"},
        {
            "er_specimen_name": "s1",
            "measurement_date": "2008:07:01",
            "measurement_time_zone": "XYZ",
        },
        {"er_specimen_name": "s1", "measurement_date": "2008:02:30"},
    ]
    tables = {"contribution": [{"magic_version": "2.5"}], "magic_measurements": rows}
    result = _upgrade(magic_node, tables)
    stamps = [m.get("timestamp") for m in result.parsed.tables["measurements"]]
    assert stamps == ["2008-07-01T20:46:00Z", "July 1st", "2008-07-01T00:00:00Z", "2008:02:30"]
    warnings = " ".join(_messages(result.report.warnings))
    assert "July 1st" in warnings and '"XYZ"' in warnings and "2008:02:30" in warnings


def test_criteria_of_minus_999_are_skipped(magic_node):
    tables = {
        "contribution": [{"magic_version": "2.5"}],
        "pmag_criteria": [{"pmag_criteria_code": "DE-SITE", "site_k": "-999", "site_n": "5"}],
    }
    criteria = _upgrade(magic_node, tables).parsed.tables["criteria"]
    criteria_map = magic_node.load_data_model("3.0")["criteria_map"]
    assert [c["table_column"] for c in criteria] == [criteria_map["site_n"]["table_column"]]


def test_chi_normalised_intensities_land_in_int_rel_chi(magic_node):
    """The legacy upgrade wrote IE-CHI intensities into `int_rel_CHI`, a
    column 3.0 does not have."""
    tables = {
        "contribution": [{"magic_version": "2.5"}],
        "pmag_results": [
            {"er_site_names": "A", "average_int_rel": "1", "magic_method_codes": "IE-CHI"}
        ],
    }
    site = _upgrade(magic_node, tables).parsed.tables["sites"][0]
    assert site["int_rel_chi"] == "1" and "int_rel" not in site


def test_retired_tables_are_noted(magic_node):
    tables = {
        "contribution": [{"magic_version": "2.5"}],
        "magic_methods": [{"magic_method_code": "LP-DIR"}],
    }
    report = _upgrade(magic_node, tables).report
    assert [n.kind for n in report.notes if n.table == "magic_methods"] == ["dropped_table"]
    assert report.warnings == []


# -- whole files ---------------------------------------------------------------


@pytest.mark.parametrize(
    "fixture, version",
    [("3552", "2.2"), ("7661", "2.3"), ("8055", "2.4"), ("10507_partial", "2.5")],
)
def test_whole_contribution_upgrades_to_3_0(magic_node, fixture, version):
    """Legacy fixture contributions, one per old version: the whole chain to
    3.0 with no upgrade errors, only 3.0 tables, and nothing the 3.0 model
    calls an unknown table."""
    text = (HERE / "fixtures" / f"{fixture}.txt").read_text()
    result = upgrade_parsed(magic_node, parse_text(text))
    assert result.report.from_version == version and not result.report.guessed
    assert result.report.steps[-1] == "2.5 → 3.0"
    assert _messages(result.report.errors) == []
    model = magic_node.load_data_model("3.0")
    assert set(result.parsed.tables) <= set(model["tables"])
    assert result.parsed.tables["contribution"][0]["data_model_version"] == "3.0"
    report = validate_contribution(magic_node, result.parsed, "3.0")
    assert not [e for e in report.errors if "unrecognized table" in e.message]
    # The upgraded text parses back to the same tables.
    assert parse_text(upgraded_text(magic_node, result)).tables == result.parsed.tables


def test_example_upload_upgrades(magic_node):
    """The upload page's 2.5 example (legacy upload_contribution.jsx)."""
    result = upgrade_parsed(magic_node, parse_text(EXAMPLE.read_text()))
    assert result.report.from_version == "2.5"
    assert _messages(result.report.errors) == []
    tables = result.parsed.tables
    assert len(tables["sites"]) == 24 and len(tables["specimens"]) == 79
    kinds = {n.kind for n in result.report.notes}
    assert {"renamed", "merged", "merged_rows", "dropped_column", "dropped_table"} <= kinds
    assert "Upgraded from data model version 2.5 to 3.0" in result.report.as_text()
