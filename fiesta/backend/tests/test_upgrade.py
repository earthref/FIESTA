"""The core data-model upgrade (fiesta.domain.upgrade): the upgrade map and
model changes from `previous_columns`, version detection, every MagIC 2.x
step by the models alone, merging, and what the report says.

Ports legacy MagIC upgrade_contribution.tests.js "when calculating the upgrade
map" and the generic "when upgrading (in)valid JSON" cases, and
data_model_changes.tests.js; the 2.5 -> 3.0 cases live with the plugin that
supplies that step (configurations/plugins/magic-3-upgrade).
"""

import httpx
import pytest
from _paths import CONFIG_DIR

from fiesta.domain.parse import ParsedContribution
from fiesta.domain.upgrade import (
    BlankDefault,
    RowPlan,
    UpgradeOptions,
    UpgradeStep,
    detect_version,
    merge_rows,
    model_changes,
    upgrade,
    upgrade_map,
)
from fiesta.nodeconfig import get_deployment
from fiesta.settings import get_settings


def _model(version: str, tables: dict[str, dict[str, list | dict]]) -> dict:
    """A small model: {table: {column: [previous "table.column", ...] or a
    column definition}}."""
    out = {"data_model_version": version, "tables": {}}
    for position, (table, columns) in enumerate(tables.items(), start=1):
        defs = {}
        for column, spec in columns.items():
            if isinstance(spec, dict):
                defs[column] = spec
            else:
                previous = [dict(zip(("table", "column"), p.split("."), strict=True)) for p in spec]
                defs[column] = {"previous_columns": previous} if previous else {}
        out["tables"][table] = {"position": position, "columns": defs}
    return out


def _run(tables, models, chain=None, hooks=None, **options):
    chain = chain or list(models)
    return upgrade(
        ParsedContribution(tables=tables),
        chain,
        models.__getitem__,
        hooks,
        UpgradeOptions(**options),
        model_name="Test Data Model",
    )


def _magic(node):
    return {v: node.load_data_model(v) for v in node.data_model.versions}


# -- the upgrade map (legacy "when calculating the upgrade map") ---------------


@pytest.mark.parametrize(
    "new_model, expected",
    [
        pytest.param(
            _model("2", {"locations": {"location_name": ["er_locations.location_name"]}}),
            {"er_locations": {"location_name": [("locations", "location_name")]}},
            id="renamed tables",
        ),
        pytest.param(
            _model(
                "3.0",
                {"contribution": {"id": ["contribution.id"], "version": ["contribution.version"]}},
            ),
            {
                "contribution": {
                    "id": [("contribution", "id")],
                    "version": [("contribution", "version")],
                }
            },
            id="multiple columns",
        ),
        pytest.param(
            _model("2", {"er_locations": {"location_name": []}}), {}, id="inserted columns"
        ),
        pytest.param(
            _model("2", {"er_locations": {"location_name": ["er_locations.name"]}}),
            {"er_locations": {"name": [("er_locations", "location_name")]}},
            id="renamed columns",
        ),
        pytest.param(
            _model(
                "2",
                {
                    "er_locations": {
                        "location_name1": ["er_locations.splitColName"],
                        "location_name2": ["er_locations.splitColName"],
                    }
                },
            ),
            {
                "er_locations": {
                    "splitColName": [
                        ("er_locations", "location_name1"),
                        ("er_locations", "location_name2"),
                    ]
                }
            },
            id="split columns",
        ),
        pytest.param(
            _model(
                "2",
                {
                    "er_locations": {
                        "location_name": ["er_locations.col_name1", "er_locations.col_name2"]
                    }
                },
            ),
            {
                "er_locations": {
                    "col_name1": [("er_locations", "location_name")],
                    "col_name2": [("er_locations", "location_name")],
                }
            },
            id="merged columns",
        ),
    ],
)
def test_upgrade_map(new_model, expected):
    assert upgrade_map(new_model) == expected


# -- model changes (legacy data_model_changes.tests.js) ------------------------


@pytest.mark.parametrize(
    "model, message",
    [
        (None, 'no "tables"'),
        ({}, 'no "tables"'),
        ({"data_model_version": "3.0", "no_tables": {}}, 'no "tables"'),
        (
            {"data_model_version": "3.0", "tables": {"contribution": {"no_columns": {}}}},
            'no "columns"',
        ),
        (
            {
                "data_model_version": "3.0",
                "tables": {"t": {"columns": {"c": {"previous_columns": [{"table": "t"}]}}}},
            },
            "lacks its table or column",
        ),
    ],
)
def test_model_changes_rejects_invalid_models(model, message):
    with pytest.raises(ValueError, match=message):
        model_changes(model)


def test_model_changes_lists_each_kind():
    old = _model("1", {"t": {"same": [], "old_name": [], "a": [], "b": [], "gone": []}})
    new = _model(
        "2",
        {
            "t": {
                "same": ["t.same"],
                "new_name": ["t.old_name"],
                "ab": ["t.a", "t.b"],
                "fresh": [],
            },
            "u": {"moved": ["t.same"]},
        },
    )
    assert model_changes(new, old) == {
        "inserted": {"t": ["fresh"]},
        "renamed": {
            "t": {"new_name": {"table": "t", "column": "old_name"}},
            "u": {"moved": {"table": "t", "column": "same"}},
        },
        "merged": {"t": {"ab": [{"table": "t", "column": "a"}, {"table": "t", "column": "b"}]}},
        "deleted": {"t": ["gone"]},
    }


@pytest.mark.parametrize(
    "old, new, inserted, deleted, merged",
    [("2.2", "2.3", 26, 4, 0), ("2.3", "2.4", 53, 19, 0), ("2.4", "2.5", 85, 0, 0)],
)
def test_model_changes_of_the_magic_2_models(magic_node, old, new, inserted, deleted, merged):
    changes = model_changes(magic_node.load_data_model(new), magic_node.load_data_model(old))
    count = lambda kind: sum(len(v) for v in changes[kind].values())  # noqa: E731
    assert (count("inserted"), count("deleted"), count("merged")) == (inserted, deleted, merged)
    assert changes["renamed"] == {}


def test_model_changes_of_the_magic_3_model(magic_node):
    changes = model_changes(magic_node.load_data_model("3.0"), magic_node.load_data_model("2.5"))
    assert changes["renamed"]["sites"]["result_quality"] == {
        "table": "pmag_sites",
        "column": "site_flag",
    }
    assert {"table": "rmag_hysteresis", "column": "hysteresis_flag"} in changes["merged"][
        "specimens"
    ]["result_quality"]
    assert sum(len(v) for v in changes["merged"].values()) == 161
    assert "magic_methods" in changes["deleted"]


# -- version detection ---------------------------------------------------------


def test_detect_version(magic_node):
    versions, load = magic_node.data_model.versions, magic_node.load_data_model

    def detect(tables):
        return detect_version(ParsedContribution(tables=tables), versions, load)

    assert detect({"contribution": [{"magic_version": "2.4"}]}) == ("2.4", False)
    assert detect({"contribution": [{"data_model_version": "2.5"}]}) == ("2.5", False)
    # Legacy "should warn about guessing the data model version".
    assert detect(
        {"locations": [{"location": "A"}], "measurements": [{"number": "1", "experiment": "A"}]}
    ) == ("3.0", True)
    # By the columns only one 2.x model defines.
    assert detect({"pmag_results": [{"iaga_res_no": "1"}]}) == ("2.2", True)
    assert detect({"er_plots": [{"plot_title": "t"}]}) == ("2.5", True)
    assert detect({"er_sites": [{"er_site_name": "a"}]}) == ("2.5", True)
    assert detect({"nothing": [{"x": "1"}]}) == (None, True)


def test_a_guessed_version_is_reported(magic_node):
    _, report = upgrade(
        ParsedContribution(tables={"er_sites": [{"er_site_name": "a"}]}),
        ["2.5", "3.0"],
        magic_node.load_data_model,
        guessed=True,
        model_name="MagIC Data Model",
    )
    assert report.guessed
    assert any("guessed that the contribution is using" in n.message for n in report.warnings)


# -- every MagIC step, by the models alone ------------------------------------


def test_step_2_2_to_2_3(magic_node):
    tables = {
        "contribution": [{"magic_version": "2.2"}],
        "pmag_results": [{"pmag_result_name": "r1", "iaga_res_no": "17"}],
    }
    out, report = _run(tables, _magic(magic_node), ["2.2", "2.3"])
    assert out.tables == {
        "contribution": [{"magic_version": "2.3"}],
        "pmag_results": [{"pmag_result_name": "r1"}],
    }
    [dropped] = [n for n in report.warnings if n.kind == "dropped_column"]
    assert (dropped.table, dropped.column) == ("pmag_results", "iaga_res_no")
    assert "is unnecessary in Test Data Model version 2.3" in dropped.message


def test_step_2_3_to_2_4(magic_node):
    tables = {
        "contribution": [{"magic_version": "2.3"}],
        "rmag_results": [{"rmag_result_name": "r1", "compilation_ids": "4"}],
    }
    out, report = _run(tables, _magic(magic_node), ["2.3", "2.4"])
    assert out.tables["rmag_results"] == [{"rmag_result_name": "r1"}]
    assert [n.column for n in report.warnings] == ["compilation_ids"]


def test_step_2_4_to_2_5(magic_node):
    """A column 2.5 added, written into a 2.4 file: kept (and reported)."""
    tables = {
        "contribution": [{"magic_version": "2.4"}],
        "pmag_specimens": [{"er_specimen_name": "s1", "specimen_scat": "g"}],
    }
    out, report = _run(tables, _magic(magic_node), ["2.4", "2.5"])
    assert out.tables == {
        "contribution": [{"magic_version": "2.5"}],
        "pmag_specimens": [{"er_specimen_name": "s1", "specimen_scat": "g"}],
    }
    assert [n.kind for n in report.warnings] == ["unknown_column"]


def test_step_2_5_to_3_0_by_the_models_alone(magic_node):
    """Renames, a split of a sample's site name into the sites table and a
    merge of the rows two old tables give one site."""
    tables = {
        "contribution": [{"magic_version": "2.5"}],
        "er_sites": [{"er_site_name": "s1", "er_location_name": "L", "site_lat": "10"}],
        "pmag_sites": [{"er_site_name": "s1", "site_dec": "350"}],
        "er_samples": [{"er_sample_name": "a", "er_site_name": "s1"}],
    }
    out, report = _run(tables, _magic(magic_node), ["2.5", "3.0"])
    assert out.tables == {
        "contribution": [{"data_model_version": "3.0"}],
        "sites": [{"site": "s1", "location": "L", "lat": "10", "dir_dec": "350"}],
        "samples": [{"sample": "a", "site": "s1"}],
    }
    notes = {(n.kind, n.table, n.column): n for n in report.notes}
    assert notes[("renamed", "er_sites", "site_lat")].to == ["sites.lat"]
    # sites.site takes the site names of er_sites, pmag_sites and er_samples.
    assert notes[("merged", "pmag_sites", "er_site_name")].to == ["sites.site"]
    assert ("merged_rows", "sites", None) in notes


def test_whole_chain_by_the_models_alone(magic_node):
    tables = {
        "contribution": [{"magic_version": "2.2"}],
        "er_locations": [{"er_location_name": "L", "location_type": "Outcrop"}],
    }
    out, report = _run(tables, _magic(magic_node))
    assert report.steps == ["2.2 → 2.3", "2.3 → 2.4", "2.4 → 2.5", "2.5 → 3.0"]
    assert out.tables == {
        "contribution": [{"data_model_version": "3.0"}],
        "locations": [{"location": "L", "location_type": "Outcrop"}],
    }
    assert report.errors == [] and report.warnings == []


# -- unknown columns and tables (MagIC #308) -----------------------------------

MODELS = {
    "1": _model("1", {"contribution": {"version": []}, "things": {"name": [], "size": []}}),
    "2": _model(
        "2",
        {
            "contribution": {"version": ["contribution.version"]},
            "items": {"item": ["things.name"], "size": ["things.size"], "notes": []},
        },
    ),
}


def test_unknown_columns_are_kept_and_reported_once():
    """Legacy reported an error per step and dropped the column; it is kept
    under its name in the table its row went to, for the importer to map."""
    tables = {"contribution": [{"version": "1"}], "things": [{"name": "a", "colour": "red"}] * 2}
    three = {**MODELS, "3": _model("3", {"items": {"item": ["items.item"]}})}
    out, report = _run(tables, three)
    assert out.tables["items"] == [{"item": "a", "colour": "red"}] * 2
    [note] = [n for n in report.notes if n.kind == "unknown_column"]
    assert (note.level, note.count, note.to) == ("warning", 2, ["items.colour"])
    assert report.errors == []


def test_unknown_columns_can_be_dropped():
    tables = {"things": [{"name": "a", "colour": "red"}]}
    out, report = _run(tables, MODELS, unknown_columns="drop")
    assert out.tables["items"] == [{"item": "a"}]
    assert "dropped" in report.warnings[0].message


def test_unknown_tables():
    tables = {"things": [{"name": "a"}], "extras": [{"x": "1"}]}
    kept, report = _run(tables, MODELS)
    assert kept.tables["extras"] == [{"x": "1"}]
    assert (
        'Table "extras" is not defined in Test Data Model version 1' in report.warnings[0].message
    )
    dropped, _ = _run(tables, MODELS, unknown_columns="drop")
    assert "extras" not in dropped.tables


def test_renames_before_the_upgrade():
    """The contributor names a misspelt column, or ignores one (MagIC #308)."""
    tables = {"things": [{"nmae": "a", "junk": "x"}]}
    out, report = _run(tables, MODELS, renames={"things.nmae": "name", "things.junk": ""})
    assert out.tables["items"] == [{"item": "a"}]
    assert report.warnings == []


# -- mapping details -------------------------------------------------------------


def test_dropped_tables_and_columns_are_reported():
    old = _model("1", {"things": {"name": [], "gone": []}, "retired": {"x": []}})
    new = _model("2", {"items": {"item": ["things.name"]}})
    out, report = _run(
        {"things": [{"name": "a", "gone": "1"}], "retired": [{"x": "1"}]}, {"1": old, "2": new}
    )
    assert out.tables == {"contribution": [{"data_model_version": "2"}], "items": [{"item": "a"}]}
    kinds = sorted((n.kind, n.table) for n in report.warnings)
    assert kinds == [("dropped_column", "things"), ("dropped_table", "retired")]


def test_collisions_keep_the_first_value():
    old = _model("1", {"t": {"a": [], "b": []}})
    new = _model("2", {"t": {"ab": ["t.a", "t.b"]}})
    out, report = _run({"t": [{"a": "1", "b": "2"}, {"a": "3", "b": "3"}]}, {"1": old, "2": new})
    assert out.tables["t"] == [{"ab": "1"}, {"ab": "3"}]
    [error] = report.errors
    assert error.kind == "collision" and error.count == 1 and error.to == ["t.ab"]


def test_lists_are_sorted_and_trimmed():
    old = _model("1", {"t": {"codes": []}})
    new = _model(
        "2",
        {"t": {"codes": {"type": "List", "previous_columns": [{"table": "t", "column": "codes"}]}}},
    )
    out, _ = _run({"t": [{"codes": " b : a :b:"}]}, {"1": old, "2": new})
    assert out.tables["t"] == [{"codes": "a:b"}]


def test_a_step_restricts_rows_to_a_table_and_values_it_cannot_place_are_reported():
    """MagIC #342: a row the step assigns to one table loses the values that
    table has no column for, and the report says so."""
    old = _model("1", {"results": {"name": [], "level": [], "vgp": []}})
    new = _model(
        "2",
        {
            "sites": {"site": ["results.name"], "vgp": ["results.vgp"]},
            "samples": {"sample": ["results.name"]},
        },
    )

    class ByLevel(UpgradeStep):
        quiet_columns = frozenset({"level"})

        def map_row(self, ctx, table, index, row):
            return RowPlan(row, frozenset({row.pop("level")}))

    rows = [
        {"name": "a", "level": "sites", "vgp": "80"},
        {"name": "b", "level": "samples", "vgp": "70"},
    ]
    out, report = _run({"results": rows}, {"1": old, "2": new}, hooks={("1", "2"): ByLevel()})
    assert out.tables["sites"] == [{"site": "a", "vgp": "80"}]
    assert out.tables["samples"] == [{"sample": "b"}]
    [note] = report.warnings
    assert (note.kind, note.column, note.to) == ("dropped_value", "vgp", ["samples"])


def test_blank_defaults_are_choices():
    old = _model("1", {"t": {"name": [], "flag": []}})
    new = _model("2", {"t": {"name": ["t.name"], "flag": ["t.flag"]}})

    class Defaults(UpgradeStep):
        defaults = (BlankDefault("flag", "Blank flag → g"),)

        def map_row(self, ctx, table, index, row):
            if "flag" not in row and ctx.default("flag"):
                row["flag"] = "g"
            return RowPlan(row)

    tables = {"t": [{"name": "a"}, {"name": "b", "flag": "b"}]}
    hooks = {("1", "2"): Defaults()}
    on, report = _run(tables, {"1": old, "2": new}, hooks=hooks)
    assert on.tables["t"] == [{"name": "a", "flag": "g"}, {"name": "b", "flag": "b"}]
    assert report.defaults == [
        {"key": "flag", "label": "Blank flag → g", "on": True, "count": 1, "step": "1 → 2"}
    ]
    off, _ = _run(tables, {"1": old, "2": new}, hooks=hooks, defaults={"flag": False})
    assert off.tables["t"][0] == {"name": "a"}


# -- merging ----------------------------------------------------------------------


def test_merge_rows():
    rows = [
        {"site": "10", "lat": "1"},
        {"site": "9", "lat": "2"},
        {"site": "10", "dec": "5", "description": "second"},
        {"site": "10", "lat": "3"},
        {"site": "9", "description": "first", "lat": "2"},
    ]
    merged, folded = merge_rows(rows, ["site"])
    # Numeric keys sort numerically; a row folds into every later row with
    # the same key it does not contradict; descriptions are joined.
    assert merged == [
        {"site": "9", "lat": "2", "description": "first"},
        {"site": "10", "lat": "1", "dec": "5", "description": "second"},
        {"site": "10", "lat": "3"},
    ]
    assert folded == 2
    joined, _ = merge_rows(
        [{"k": "a", "description": "One"}, {"k": "a", "description": "two"}], ["k"]
    )
    assert joined == [{"k": "a", "description": "One; two"}]


def test_report_text_and_dict(magic_node):
    tables = {
        "contribution": [{"magic_version": "2.2"}],
        "pmag_results": [{"pmag_result_name": "r1", "iaga_res_no": "17"}],
    }
    _, report = _run(tables, _magic(magic_node), ["2.2", "2.3"])
    text = report.as_text()
    assert text.startswith("Upgraded from data model version 2.2 to 2.3")
    assert "iaga_res_no" in text and "Warnings:" in text
    data = report.as_dict()
    assert data["steps"] == ["2.2 → 2.3"] and data["rows_out"]["pmag_results"] == 1


# -- the API ----------------------------------------------------------------------

OLD_TEXT = (
    "tab\tcontribution\nmagic_version\n2.5\n>>>>>>>>>>\n"
    "tab\ter_sites\ner_site_name\tsite_lat\tcolour\ns1\t10\tred\n"
)


@pytest.fixture
async def client(monkeypatch):
    monkeypatch.setenv("FIESTA_CONFIG_FILE", str(CONFIG_DIR / "fiesta.yaml"))
    monkeypatch.delenv("FIESTA_NODE", raising=False)
    get_settings.cache_clear()
    get_deployment.cache_clear()
    from fiesta.apps.api import create_app

    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://api") as client:
        yield client
    get_settings.cache_clear()
    get_deployment.cache_clear()


async def test_upgrade_endpoint(client):
    response = await client.post("/v2/magic/upgrade", json={"text": OLD_TEXT})
    assert response.status_code == 200
    body = response.json()
    assert (body["upgraded"], body["from_version"], body["to_version"]) == (True, "2.5", "3.0")
    assert "tab delimited\tsites\nsite\tlat\tcolour\ns1\t10\tred" in body["text"]
    assert any(n["kind"] == "unknown_column" for n in body["report"]["notes"])
    assert body["report_text"].startswith("Upgraded from data model version 2.5 to 3.0")

    dropped = await client.post(
        "/v2/magic/upgrade", json={"text": OLD_TEXT, "unknown_columns": "drop"}
    )
    assert "colour" not in dropped.json()["text"]
    renamed = await client.post(
        "/v2/magic/upgrade", json={"text": OLD_TEXT, "renames": {"er_sites.colour": ""}}
    )
    assert renamed.json()["report"]["notes"][0]["message"] == "er_sites.colour ignored"

    latest = await client.post(
        "/v2/magic/upgrade", json={"text": "tab delimited\tsites\nsite\ns1\n"}
    )
    assert latest.json()["upgraded"] is False and latest.json()["from_version"] == "3.0"
    bad = await client.post("/v2/magic/upgrade", json={"text": "nonsense"})
    assert bad.status_code == 422
