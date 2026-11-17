"""The depth-plot plugin: its payload (tracks, ratios, sections, the rows it
leaves out or flags) and its option checks, against CDR's YAML and model."""

import pytest

from fiesta.plugins import all_plugins
from fiesta.plugins.depth_plot import DepthPlotOptions, numeric_columns, plot_payload


def _options(node) -> DepthPlotOptions:
    options = all_plugins()["depth-plot"].options(node)
    assert isinstance(options, DepthPlotOptions)
    return options


def test_payload_tracks_ratios_sections_and_left_out_rows(cdr_node):
    tables = {
        "sections": [{"section": "1", "core": "26PC"}, {"section": "2", "core": "26PC"}],
        "measurements": [
            # Calibration: its section and a negative depth both leave it out.
            {"section": "cal", "mbs_corrected": "-0.6", "depth": "0", "res": "288"},
            {"section": "1", "mbs_corrected": "-0.1", "res": "5"},
            {"section": "2", "mbs_corrected": "1.5", "ca": "400", "ti": "100", "quality": "g"},
            {"section": "1", "mbs_corrected": "0.5", "ca": "300", "ti": "150", "cl": "9"},
            {"section": "1", "mbs_corrected": "0.7", "ca": "1e9", "ti": "1", "quality": "b"},
            # No numeric value: no row.
            {"section": "2", "mbs_corrected": "1.6", "description": "gap"},
            # Falls back to `depth` without mbs_corrected.
            {"section": "2", "depth": "1.9", "ca": "410", "ti": "nan"},
        ],
    }
    payload = plot_payload(_options(cdr_node), numeric_columns(cdr_node), tables)

    rows = payload["cores"]["26PC"]
    assert [r["depth"] for r in rows] == [0.5, 0.7, 1.5, 1.9]
    assert [r.get("_bad", False) for r in rows] == [False, True, False, False]
    assert "ti" not in rows[3], "non-finite values are dropped"
    assert payload["sections"]["26PC"] == [
        {"section": "1", "top": 0.5, "bottom": 0.7},
        {"section": "2", "top": 1.5, "bottom": 1.9},
    ]

    tracks = {t["key"]: t for t in payload["tracks"]}
    # YAML series first (their labels, default on), then other columns with
    # data in model order (model label and unit, picked on request).
    assert list(tracks) == ["ca", "ti", "cl"]
    assert tracks["ca"]["label"] == "Ca (cps)" and tracks["ca"]["default"]
    assert tracks["cl"]["label"] == "Chlorine (cps)" and not tracks["cl"]["default"]
    assert tracks["cl"]["group"].startswith("X-Ray")
    assert "res" not in tracks, "only calibration rows had resistivity"

    # Only ratios whose two columns have data.
    assert [r["key"] for r in payload["ratios"]] == ["ln_ca_ti"]
    assert payload["ratios"][0]["label"] == "ln(Ca/Ti)" and payload["ratios"][0]["default"]


def test_new_xrf_elements_are_tracks(cdr_node):
    columns = numeric_columns(cdr_node)
    for key in ("al", "si", "ba", "mo_inc", "xrf_total_cps"):
        assert columns[key]["group"].startswith("X-Ray")
    assert "xrf_processing_params" not in columns, "a Dictionary is no track"
    payload = plot_payload(
        _options(cdr_node),
        columns,
        {"measurements": [{"section": "1", "depth": "0.1", "si": "12", "mo_inc": "3"}]},
    )
    assert [t["key"] for t in payload["tracks"]] == ["si", "mo_inc"]


def test_options_are_checked_against_the_model(cdr_node):
    plugin = all_plugins()["depth-plot"]
    options = _options(cdr_node)
    plugin.check(cdr_node, options)
    bad = options.model_copy(
        update={
            "ratios": [*options.ratios, options.ratios[0].model_copy(update={"numerator": "xx"})]
        }
    )
    with pytest.raises(ValueError, match="xx"):
        plugin.check(cdr_node, bad)
    with pytest.raises(ValueError, match="nope"):
        plugin.check(cdr_node, options.model_copy(update={"quality_column": "nope"}))
    config = plugin.frontend_config(cdr_node)
    assert [r["key"] for r in config["ratios"]] == ["ln_ca_ti", "zr_rb", "mn_ti", "br_ti"]
