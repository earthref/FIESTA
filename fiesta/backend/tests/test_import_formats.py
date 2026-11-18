"""Import formats plugins supply (FiestaPlugin.import_formats, the core half:
fiesta.services.import_formats and the /import-formats routes), with a fake
format; MagIC's PmagPy formats are tested in their plugin's folder."""

import base64

import httpx
import pytest
from _paths import CONFIG_DIR
from pydantic import ValidationError

import fiesta.plugins
from fiesta.nodeconfig import get_deployment
from fiesta.plugins.base import (
    FiestaPlugin,
    ImportConversionError,
    ImportFormat,
    ImportNote,
    ImportOptions,
    ImportResult,
)
from fiesta.services import import_formats as svc
from fiesta.settings import get_settings


class FakeOptions(ImportOptions):
    site_prefix: str = ""
    fail: bool = False


class FakeFormat(ImportFormat):
    """`.fake` files: one site per line; a line `with <name>` reads that file too."""

    key = "fake"
    label = "Fake File"
    multi_file = True
    Options = FakeOptions

    def sniff(self, filename, head):
        return 0.9 if filename.endswith(".fake") else (0.5 if head.startswith(b"x") else 0.0)

    def companions(self, filename, head, others):
        listed = {line[5:] for line in head.decode().splitlines() if line.startswith("with ")}
        return [name for name in others if name in listed]

    def convert(self, node, files, options):
        if options.fail:
            raise ImportConversionError("told to fail", [ImportNote("warning", "careful")])
        sites = []
        for name in files.files:
            for line in (files.directory / name).read_text().splitlines():
                if line == "boom":
                    raise RuntimeError("the converter crashed")
                if line == "garbage":
                    return ImportResult(text="nonsense")
                if line and not line.startswith("with "):
                    sites.append(options.site_prefix + line)
        text = "tab delimited\tsites\nsite\n" + "\n".join(sites) if sites else ""
        return ImportResult(
            text=text,
            notes=[ImportNote("info", "converted", kind="converter")],
            tool={"name": "Fake", "version": "1.0", "function": "fake"},
        )


class OtherFormat(ImportFormat):
    key = "other"
    label = "Other"

    def sniff(self, filename, head):
        return 0.95 if filename.endswith(".other") else 0.0


class FakePlugin(FiestaPlugin):
    name = "fake-formats"
    formats: tuple[ImportFormat, ...] = (FakeFormat(), OtherFormat())

    def import_formats(self, node):
        return list(self.formats)


@pytest.fixture
def fake(monkeypatch):
    plugin = FakePlugin()
    monkeypatch.setattr(fiesta.plugins, "active_plugins", lambda node: [plugin])
    return plugin


def _files(**contents):
    return [
        svc.UploadedFile(name.replace("_", "."), data.encode()) for name, data in contents.items()
    ]


def test_formats_are_listed_with_their_options_schema(magic_node, fake):
    listed = svc.describe(magic_node)
    assert [f["key"] for f in listed] == ["fake", "other"]
    assert listed[0]["plugin"] == "fake-formats" and listed[0]["multi_file"] is True
    assert set(listed[0]["options_schema"]["properties"]) == {"site_prefix", "fail"}


def test_two_plugins_may_not_supply_one_key(magic_node, monkeypatch):
    plugin = FakePlugin()
    monkeypatch.setattr(fiesta.plugins, "active_plugins", lambda node: [plugin, plugin])
    with pytest.raises(ValueError, match="two plugins supply the import format 'fake'"):
        svc.import_formats(magic_node)


def test_sniff_picks_formats_and_companions(magic_node, fake):
    files = [
        svc.UploadedFile("a.fake", b"s1\nwith b\nwith c.other\nwith d\n"),
        svc.UploadedFile("b", b"xs2\n"),  # unsure on its own: read with a.fake
        svc.UploadedFile("c.other", b""),  # confidently another format: stays so
        svc.UploadedFile("d", b""),  # in no format on its own: still a companion
        svc.UploadedFile("e.txt", b""),
    ]
    results = {r["name"]: r for r in svc.sniff(magic_node, files)}
    assert results["a.fake"] == {
        "name": "a.fake",
        "format": "fake",
        "confidence": 0.9,
        "companion_of": None,
    }
    assert (results["b"]["format"], results["b"]["companion_of"]) == ("fake", "a.fake")
    assert (results["c.other"]["format"], results["c.other"]["companion_of"]) == ("other", None)
    assert results["d"]["companion_of"] == "a.fake"
    assert (results["e.txt"]["format"], results["e.txt"]["confidence"]) == (None, 0.0)


def test_convert_counts_the_hierarchy_and_writes_a_report(magic_node, fake):
    out = svc.convert(
        magic_node, "fake", _files(a_fake="s1\ns2\nwith b", b="s3"), {"site_prefix": "X-"}
    )
    assert out["text"] == "tab delimited\tsites\nsite\nX-s1\nX-s2\nX-s3"
    assert out["tables"] == {"sites": 3}
    assert out["hierarchy"] == [{"table": "sites", "count": 3}]
    assert out["files"] == ["a.fake", "b"]
    assert out["options"] == {"site_prefix": "X-", "fail": False}
    assert out["options_set"] == ["site_prefix"]
    assert out["notes"] == [
        {"level": "info", "message": "converted", "kind": "converter", "count": 1}
    ]
    report = out["report_text"]
    assert report.startswith("Fake File conversion (plugin fake-formats)\nConverter: Fake 1.0 fake")
    assert "Files: a.fake, b" in report and '"site_prefix": "X-"' in report
    assert "Hierarchy: 3 sites" in report and "[info] converted" in report


def test_convert_failures(magic_node, fake):
    with pytest.raises(KeyError):
        svc.convert(magic_node, "nope", _files(a_fake="s1"), {})
    with pytest.raises(ValidationError):
        svc.convert(magic_node, "fake", _files(a_fake="s1"), {"typo": 1})
    with pytest.raises(ImportConversionError, match="same name"):
        svc.convert(magic_node, "fake", [*_files(a_fake="s1"), *_files(a_fake="s2")], {})
    with pytest.raises(ImportConversionError, match="not a usable file name"):
        svc.convert(magic_node, "fake", [svc.UploadedFile("../", b"")], {})
    with pytest.raises(ImportConversionError, match="told to fail") as told:
        svc.convert(magic_node, "fake", _files(a_fake="s1"), {"fail": True})
    assert told.value.notes[0].message == "careful"
    with pytest.raises(ImportConversionError, match="conversion failed: the converter crashed"):
        svc.convert(magic_node, "fake", _files(a_fake="boom"), {})
    with pytest.raises(ImportConversionError, match="cannot be read"):
        svc.convert(magic_node, "fake", _files(a_fake="garbage"), {})
    with pytest.raises(ImportConversionError, match="no rows"):
        svc.convert(magic_node, "fake", _files(a_fake="with b"), {})


def test_a_path_in_a_name_is_dropped(magic_node, fake):
    out = svc.convert(magic_node, "fake", [svc.UploadedFile("dir/../x/a.fake", b"s1")], {})
    assert out["files"] == ["a.fake"]


# -- the API ----------------------------------------------------------------------


async def _app(monkeypatch, *, signed_in=True, limit=None):
    monkeypatch.setenv("FIESTA_CONFIG_FILE", str(CONFIG_DIR / "fiesta.yaml"))
    monkeypatch.delenv("FIESTA_NODE", raising=False)
    if limit is not None:
        monkeypatch.setenv("FIESTA_MAX_UPLOAD_BYTES", str(limit))
    get_settings.cache_clear()
    get_deployment.cache_clear()
    from fiesta.apps.api import create_app
    from fiesta.apps.deps import get_current_user
    from fiesta.db.models import User

    app = create_app()
    plugin = FakePlugin()
    monkeypatch.setattr(fiesta.plugins, "active_plugins", lambda node: [plugin])
    if signed_in:
        app.dependency_overrides[get_current_user] = lambda: User(
            id=1, email="ada@example.test", name="Ada", is_admin=False
        )
    return app


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


async def test_import_format_endpoints(monkeypatch):
    app = await _app(monkeypatch, signed_in=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://a") as c:
        listed = await c.get("/v2/magic/import-formats")
        assert [f["key"] for f in listed.json()] == ["fake", "other"]
        sniffed = await c.post(
            "/v2/magic/import-formats/sniff",
            json={"files": [{"name": "a.fake", "head": _b64(b"s1")}]},
        )
        assert sniffed.json()["auto_pick"] == 0.8
        assert sniffed.json()["files"][0]["format"] == "fake"
        body = {"files": [{"name": "a.fake", "data": _b64(b"s1")}]}
        # Converting is a contributor action: it needs a login.
        assert (await c.post("/v2/magic/import-formats/fake/convert", json=body)).status_code == 401

    body = {"files": [{"name": "a.fake", "data": _b64(b"s1\ns2")}], "options": {}}
    app = await _app(monkeypatch, limit=200)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://a") as c:
        ok = await c.post("/v2/magic/import-formats/fake/convert", json=body)
        assert ok.status_code == 200 and ok.json()["tables"] == {"sites": 2}
        missing = await c.post("/v2/magic/import-formats/nope/convert", json=body)
        assert missing.status_code == 404
        bad = await c.post(
            "/v2/magic/import-formats/fake/convert", json={**body, "options": {"typo": 1}}
        )
        assert bad.status_code == 422 and bad.json()["detail"].startswith("options: typo")
        failed = await c.post(
            "/v2/magic/import-formats/fake/convert", json={**body, "options": {"fail": True}}
        )
        assert failed.status_code == 422 and failed.json()["detail"] == "told to fail (careful)"
        not_b64 = {"files": [{"name": "a.fake", "data": "***"}]}
        assert (
            await c.post("/v2/magic/import-formats/fake/convert", json=not_b64)
        ).status_code == 422
        big = {"files": [{"name": "a.fake", "data": _b64(b"s" * 300)}]}
        too_big = await c.post("/v2/magic/import-formats/fake/convert", json=big)
        assert too_big.status_code == 413 and "upload limit" in too_big.json()["detail"]
    get_settings.cache_clear()
    get_deployment.cache_clear()
