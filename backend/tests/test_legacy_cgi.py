"""Offline checks of the EarthRef CGI (ERDA) legacy reader: page -> text, owners."""

import json
from pathlib import Path

import pytest

from fiesta.domain.parse import parse_text
from fiesta.domain.validate import validate_contribution
from fiesta.nodeconfig import LegacySourceConfig
from fiesta.services.legacy import load_inventory
from fiesta.services.legacy_cgi import (
    Vocabularies,
    build_inventory,
    contribution_text,
    owner_mapping,
    parse_record,
)
from fiesta.services.revisions import digest

FIXTURE = Path(__file__).parent / "fixtures" / "erda_record_442.html"


def _text_for(node, record, sizes):
    model = node.load_data_model("1.0")
    files = [{"name": f["name"], "size": s} for f, s in zip(record["files"], sizes, strict=True)]
    return contribution_text(record, files, model, Vocabularies(node, model), {})


def test_parse_erda_record_page():
    record = parse_record(FIXTURE.read_text(encoding="utf-8"), 442)
    assert record["title"] == (
        "High resolution 40Ar/39Ar ages for the Gilberts Ridge: sample AVON2-1-7"
    )
    assert record["contributor"] == {"name": "Anthony A.P. Koppers", "legacy_id": 335}
    assert [f["name"] for f in record["files"]] == ["03c0152.age", "03c0152.xls"]
    assert record["files"][0]["path"].endswith("/03c0152.age")
    assert record["files"][0]["href"].startswith("z-download.cgi?")
    assert record["fields"]["Expert Level"] == "Graduate School"
    assert record["links"]["Source Web Site"] == ["http://earthref.org/tools/ararcalc.htm"]


def test_erda_record_text_validates(erda_node):
    record = parse_record(FIXTURE.read_text(encoding="utf-8"), 442)
    parsed = parse_text(_text_for(erda_node, record, [365568, 271360]))
    obj = parsed.tables["objects"][0]
    assert obj["object"] == "442"
    assert obj["data_types"] == "graphs:spreadsheet"
    assert (obj["computer_program"], obj["computer_program_version"]) == ("Microsoft Excel", "2000")
    # Location "4º 27.54' N - 4º 59.09' N | 172º 11.60' E - 172º 49.84' E, Pacific Ocean, ..."
    assert (obj["lat_s"], obj["lat_n"]) == ("4.459", "4.98483")
    assert (obj["lon_w"], obj["lon_e"]) == ("172.19333", "172.83067")
    assert obj["continents_oceans"] == "Pacific Ocean"
    assert obj["regions"] == "Gilberts Ridge"
    assert (obj["age_high"], obj["age_low"], obj["age_unit"]) == ("70.8", "70.8", "Ma")
    assert obj["source_url"] == "http://earthref.org/tools/ararcalc.htm"
    assert obj["copyright_owner"].startswith("Anthony A.P. Koppers; Institute of Geophysics")
    files = parsed.tables["files"]
    assert [(f["file"], f["format"], f["size_bytes"]) for f in files] == [
        ("03c0152.age", "age", "365568"),
        ("03c0152.xls", "xls", "271360"),
    ]
    assert files[1]["media_type"] == "application/vnd.ms-excel"
    report = validate_contribution(erda_node, parsed, "1.0")
    assert report.errors == []


def _page(cid, rows, extra=""):
    cells = "".join(
        f"<tr><td><span style='font-weight:bold; padding-right:15px;'>{k}</span></td>\n"
        f"<td bgcolor='#E5E5E5'>{v}</td></tr>"
        for k, v in rows.items()
    )
    return (
        f'<th>Detailed File Information</th><a  href="https://earthref.org/ERDA/{cid}/">T</a>'
        f"{cells}{extra}"
        f"<td ><b>Direct Download Link</b><br>\n"
        f"<a href=https://earthref.org/ERDA/download:{cid}/ target=main>x</a></td>"
    )


def test_single_file_and_link_only_records(erda_node):
    single = parse_record(
        _page(7, {"File Name": "a.pdf", "File Size": "1.50 KB - 1 file", "Data Type": "pdf"}), 7
    )
    assert single["files"] == [
        {
            "name": "a.pdf",
            "path": None,  # resolved from the download link's redirect
            "href": "https://earthref.org/ERDA/download:7/",
            "size_text": "1.50 KB - 1 file",
            "size_estimate": 1536,
        }
    ]
    link = parse_record(
        _page(
            8,
            {
                "File Name": "Not available",
                "Data Type": "web link",
                "Expert Level": "Graduate School",
                "Source": "http://example.org/paper",
                "Contributor": "<b><a href=erml.cgi?n=12>A B</a></b>",
            },
        ),
        8,
    )
    assert link["files"] == []
    obj = parse_text(_text_for(erda_node, link, [])).tables["objects"][0]
    assert obj["external_url"] == obj["source_url"] == "http://example.org/paper"
    assert "citations" not in obj


class FakeUsers:
    def __init__(self, users):
        self.users = users

    async def search(self, index, body, **kwargs):
        return {"hits": {"hits": [{"_source": u} for u in self.users]}, "_scroll_id": None}


def _user(uid, given, family, email):
    return {"id": uid, "name": {"given": given, "family": family}, "email": {"address": email}}


@pytest.mark.asyncio
async def test_owner_mapping_exact_full_name_only():
    client = FakeUsers(
        [
            _user(1, "Sylvia T", "Cole", "cole@example.test"),
            _user(2, "Jo", "Dup", "dup@example.test"),
            _user(3, "Jo", "Dup", "dup@example.test"),  # a duplicate document: one account
            _user(4, "Kim", "Twin", "twin1@example.test"),
            _user(5, "Kim", "Twin", "twin2@example.test"),
            _user(6, "Case", "Miss", "case@example.test"),
            _user(7, None, None, "blank@example.test"),
        ]
    )
    cfg = LegacySourceConfig(
        kind="earthref-cgi",
        source_id="legacy-test",
        base_url="https://example.test",
        max_id=10,
        default_owner="steward@placeholder.invalid",
    )
    names = {
        "Sylvia T Cole": {"legacy_ids": {1}, "records": [10, 11]},
        "Jo Dup": {"legacy_ids": {3}, "records": [12]},
        "Kim Twin": {"legacy_ids": {5}, "records": [13]},
        "case miss": {"legacy_ids": {6}, "records": [14]},
        "": {"legacy_ids": {7}, "records": [15]},
    }
    mapping = await owner_mapping(client, cfg, names)
    assert mapping["matched"]["Sylvia T Cole"]["account"]["email"] == "cole@example.test"
    assert mapping["matched"]["Sylvia T Cole"]["id_agrees"] is True
    assert mapping["matched"]["Jo Dup"]["account"]["er_users_id"] == 3
    assert set(mapping["unmatched"]) == {"Kim Twin", "case miss", ""}
    assert len(mapping["unmatched"]["Kim Twin"]["candidates"]) == 2
    # Hints only: the account at the legacy person id is listed, never applied.
    assert mapping["unmatched"]["case miss"]["legacy_id_accounts"][0]["er_users_id"] == 6
    assert mapping["unmatched"][""]["candidates"] == []
    assert mapping["default_owner_resolves"] is False


@pytest.mark.asyncio
async def test_inventory_metadata_only_exclusions_and_steward(erda_node, tmp_path):
    """From a warm cache (no network): a complete record, a record whose file the
    legacy archive lost (metadata only), an excluded id, the steward as owner."""
    legacy = erda_node.legacy.model_copy(
        update={
            "max_id": 3,
            "exclude_ids": [3],
            "incomplete_records": "metadata",
            "default_owner": "steward@example.test",
        }
    )
    node = erda_node.model_copy(update={"legacy": legacy})
    pages = tmp_path / "pages"
    pages.mkdir()
    base = {"Data Type": "pdf", "Expert Level": "Graduate School", "File Size": "1 KB - 1 file"}
    for cid, name, person in [(1, "a.pdf", "Sylvia T Cole"), (2, "b.pdf", "Nobody"), (3, "c", "")]:
        contributor = f"<b><a href=erml.cgi?n={cid}>{person}</a></b>"
        rows = base | {"File Name": name, "Contributor": contributor}
        (pages / f"{cid}.html").write_text(_page(cid, rows))
    seen = "2026-09-28T00:00:00+00:00"
    (pages / "index.json").write_text(
        json.dumps({str(i): {"live": True, "seen": seen} for i in (1, 2, 3)})
    )
    (tmp_path / "files" / "1").mkdir(parents=True)
    (tmp_path / "files" / "1" / "a.pdf").write_bytes(b"%PDF")
    (tmp_path / "files" / "index.json").write_text(
        json.dumps(
            {
                "1/a.pdf": {"path": "/x/a.pdf", "size": 4, "sha256": digest(b"%PDF")},
                "2/b.pdf": {"missing": True, "path": "/x/b.pdf"},
            }
        )
    )
    client = FakeUsers(
        [
            _user(1, "Sylvia T", "Cole", "cole@example.test"),
            _user(9, "Data", "Steward", "steward@example.test"),
        ]
    )
    report = await build_inventory(node, tmp_path, client=client, http=object())
    assert report["errors"] == []
    assert report["excluded_ids"] == [3]
    assert (report["inventory_records"], report["metadata_only_records"]) == (2, 1)
    assert report["default_owner_records"] == [2]
    inventory = load_inventory(tmp_path / "inventory.json")
    by_id = {r.id: r for r in inventory.records}
    assert by_id[1].owner_email == "cole@example.test"
    assert set(by_id[1].revisions[0].files) == {"erda_contribution_1.txt", "a.pdf"}
    assert by_id[2].owner_email == "steward@example.test"
    assert set(by_id[2].revisions[0].files) == {"erda_contribution_2.txt"}
    text = (tmp_path / "records" / "2" / "erda_contribution_2.txt").read_text()
    row = parse_text(text).tables["files"][0]
    assert row["file"] == "b.pdf" and "size_bytes" not in row
    assert row["description"] == "Not imported: lost from the legacy ERDA archive."
    assert validate_contribution(node, parse_text(text), "1.0").errors == []
    owners = json.loads((tmp_path / "owners.json").read_text())
    assert [o["email"] for o in owners] == ["cole@example.test", "steward@example.test"]
