"""Contribution modes and the data-source sync client (no infrastructure)."""

import json

import httpx
import pytest
from conftest import CONFIG_DIR

from fiesta.nodeconfig import load_deployment
from fiesta.services.legacy import SourceRecord, record_fingerprint
from fiesta.settings import get_settings, parse_contributions_mode
from fiesta.sources.client import SourceAPI


@pytest.fixture(scope="session")
def kdd_node():
    return load_deployment(CONFIG_DIR / "kdd.yaml").node_for("kdd")


@pytest.fixture
def mode(monkeypatch):
    def set_mode(value: str) -> None:
        monkeypatch.setattr(get_settings(), "contributions_mode", value)

    return set_mode


def test_parse_contributions_mode():
    assert parse_contributions_mode("") == ("public", {})
    assert parse_contributions_mode("source") == ("source", {})
    assert parse_contributions_mode(" source, KArAr=public ") == ("source", {"karar": "public"})
    assert parse_contributions_mode("kdd=source") == ("public", {"kdd": "source"})
    with pytest.raises(ValueError, match="mirror"):
        parse_contributions_mode("mirror")


def test_mode_per_node_and_write_guard(kdd_node, mode):
    from fastapi import HTTPException
    from starlette.requests import Request

    from fiesta.apps.deps import require_public_contributions, source_mode_message

    def request(method: str) -> Request:
        return Request({"type": "http", "method": method, "path": "/", "headers": []})

    mode("public")
    assert kdd_node.contributions_mode == "public"
    assert kdd_node.public_config()["contributions_mode"] == "public"
    assert source_mode_message(kdd_node) is None
    require_public_contributions(request("POST"), kdd_node)

    mode("source,kdd=source,karar=public")
    assert kdd_node.contributions_mode == "source"
    assert "earthref.org/KdD" in source_mode_message(kdd_node)
    require_public_contributions(request("GET"), kdd_node)
    with pytest.raises(HTTPException) as refused:
        require_public_contributions(request("PUT"), kdd_node)
    assert refused.value.status_code == 409


def _record(cid: int, body: bytes, **extra) -> dict:
    import hashlib

    name = f"kdd_contribution_{cid}.txt"
    return {
        "id": cid,
        "owner_email": "owner@example.test",
        "published": True,
        "created_at": "2020-01-01T00:00:00+00:00",
        "activated_at": "2020-01-02T00:00:00+00:00",
        "revisions": [
            {
                "key": "legacy",
                "timestamp": "2020-01-02T00:00:00+00:00",
                "canonical": name,
                "files": {
                    name: {
                        "source": f"files/{cid}/{name}",
                        "sha256": hashlib.sha256(body).hexdigest(),
                    }
                },
            }
        ],
    } | extra


@pytest.mark.asyncio
async def test_sync_meteor_sends_only_changed_records(kdd_node, tmp_path, monkeypatch):
    from fiesta.services import legacy_inventory
    from fiesta.sources import meteor

    bodies = {1: b"tab\tcontribution\nid\n1\n", 2: b"tab\tcontribution\nid\n2\n"}
    records = [_record(cid, body) for cid, body in bodies.items()]
    for cid, body in bodies.items():
        path = tmp_path / "files" / str(cid) / f"kdd_contribution_{cid}.txt"
        path.parent.mkdir(parents=True)
        path.write_bytes(body)

    async def fake_inventory(node, out_dir, *, client=None):
        (out_dir / "inventory.json").write_text(
            json.dumps({"format": 1, "node": "kdd", "source_id": "legacy-kdd", "records": records})
        )
        owner = {"email": "owner@example.test", "name": "Owner", "contributions": [1, 2]}
        (out_dir / "owners.json").write_text(json.dumps([owner]))
        return {
            "contributions": 3,
            "errors": [{"id": 3, "error": "no account for contributor 'Roger Nielsen'"}],
            "unresolved_handles": [],
        }

    monkeypatch.setattr(legacy_inventory, "build_inventory", fake_inventory)
    unchanged = record_fingerprint(SourceRecord.model_validate(records[0]))
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            assert request.url.path == "/v2/kdd/source/checkpoints"
            return httpx.Response(
                200,
                json={
                    "mode": "source",
                    "source_id": "legacy-kdd",
                    "checkpoints": {"1": unchanged, "7": "gone"},
                },
            )
        assert request.url.path == "/v2/kdd/source/records/2"
        body = request.read()
        assert b'name="legacy/kdd_contribution_2.txt"' in body and bodies[2] in body
        assert b'"owner@example.test"' in body and b"contributions" not in body
        sent.append(2)
        return httpx.Response(200, json={"status": "applied", "bytes": len(bodies[2])})

    api = SourceAPI("http://fiesta.test", "kdd", transport=httpx.MockTransport(handler))
    summary = await meteor.sync_meteor(kdd_node, api, tmp_path)
    assert sent == [2]
    assert summary["unchanged"] == 1 and summary["applied"] == 1
    assert summary["quarantined"] == 1 and summary["errors"] == []
    assert summary["missing_from_source"] == [7]

    dry = await meteor.sync_meteor(kdd_node, api, tmp_path, dry_run=True)
    assert dry["planned"] == [2] and sent == [2]


@pytest.mark.asyncio
async def test_sync_meteor_does_nothing_in_public_mode(kdd_node, tmp_path, monkeypatch):
    from fiesta.services import legacy_inventory
    from fiesta.sources import meteor

    async def never(*args, **kwargs):
        raise AssertionError("the source is not read in public mode")

    monkeypatch.setattr(legacy_inventory, "build_inventory", never)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, json={"mode": "public", "source_id": "legacy-kdd", "checkpoints": {}}
        )
    )
    api = SourceAPI("http://fiesta.test", "kdd", transport=transport)
    summary = await meteor.sync_meteor(kdd_node, api, tmp_path)
    assert summary["skipped"] == "node is in public mode"


def test_source_schedules_follow_node_sync(kdd_node, tmp_path, monkeypatch):
    """A node with a script gets a `<slug>-source` schedule timed and enabled by
    its `legacy.sync`; a node without one gets none; the file's own wins."""
    from fiesta.ops.config import parse_ops_config

    monkeypatch.setattr(get_settings(), "sources_dir", tmp_path)
    (tmp_path / "kdd.py").write_text("")
    owners = tmp_path / "kdd-owners.json"
    owners.write_text("{}")
    legacy = kdd_node.legacy.model_copy(
        update={"sync": kdd_node.legacy.sync.model_copy(update={"enabled": True})}
    )
    node = kdd_node.model_copy(update={"legacy": legacy})
    karar = load_deployment(CONFIG_DIR / "karar.yaml").node_for("karar")
    config = parse_ops_config(
        f"""
fiesta-ops: 1
sources:
  env_file: /etc/fiesta/source-{{slug}}.env
  owner_map: {tmp_path}/{{slug}}-owners.json
"""
    ).with_sources([node, karar])
    (schedule,) = config.schedules
    assert schedule.name == "kdd-source" and schedule.enabled and schedule.cron == "20 * * * *"
    assert schedule.env_file == "/etc/fiesta/source-kdd.env"
    assert schedule.command[1] == str(tmp_path / "kdd.py")
    assert schedule.command[-2:] == ["--owner-map", str(owners)]
    assert schedule.expected_interval > 3600
    assert kdd_node.legacy.sync.enabled is False  # the checked-in default
