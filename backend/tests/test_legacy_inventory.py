"""Offline check of the legacy inventory generator against fake OpenSearch/S3."""

import json

import pytest
from botocore.exceptions import ClientError

from fiesta.services import legacy_inventory
from fiesta.services.legacy import load_inventory
from fiesta.services.revisions import digest

PUBLIC_TEXT = "tab delimited\tcontribution\nid\tversion\n7\t2\n"


def _doc(cid, *, handle, activated, history, tables=None, **extra):
    summary = {
        "id": cid,
        "contributor": f"@{handle}",
        "_contributor": "Display Name",
        "_is_activated": "true" if activated else "false",
        "_is_latest": "true",
        "_private_key": "0b6e4e2a-1c8d-4a49-9e5f-3d1c2b4a5f60",
        "timestamp": "2024-05-02T10:00:00.000Z",
        "_history": history,
        **extra,
    }
    return {"summary": {"contribution": summary}, "contribution": tables or {}}


class FakeSearch:
    def __init__(self, docs, users):
        self.docs, self.users, self.cleared = docs, users, False

    async def search(self, index, body, **kwargs):
        if index == "er_users":
            handle = body["query"]["term"]["handle.raw"]
            hits = [{"_source": self.users[handle]}] if handle in self.users else []
            return {"hits": {"hits": hits}}
        assert index == "karar"
        assert body["query"] == {"term": {"type": "contribution"}}
        return {"_scroll_id": "s1", "hits": {"hits": [{"_source": d} for d in self.docs]}}

    async def scroll(self, scroll_id, scroll, **kwargs):
        return {"_scroll_id": scroll_id, "hits": {"hits": []}}

    async def clear_scroll(self, scroll_id):
        self.cleared = True


class FakeStorage:
    objects = {
        ("karar-activated-contributions", "7/karar_contribution_7.txt"): PUBLIC_TEXT.encode()
    }

    def __init__(self, bucket, prefix=""):
        self.bucket = bucket

    async def get_bytes(self, key, version_id=None):
        try:
            return self.objects[(self.bucket, key)]
        except KeyError:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject") from None


@pytest.mark.asyncio
async def test_build_inventory_from_index_and_buckets(karar_node, tmp_path, monkeypatch):
    monkeypatch.setattr(legacy_inventory, "Storage", FakeStorage)
    users = {
        "alice": {
            "handle": "alice",
            "email": {"address": "Alice@Example.org"},
            "name": {"given": "Alice", "family": "Ng"},
            "orcid": {"id": "0000-0002-1825-0097"},
        }
    }
    docs = [
        _doc(
            7,
            handle="alice",
            activated=True,
            history=[
                {"id": 7, "version": 2, "timestamp": "2024-05-02T10:00:00.000Z"},
                {"id": 7, "version": None, "timestamp": "2024-01-01T00:00:00.000Z"},
            ],
            version=2,
            reference="https://doi.org/10.1029/2023GC011111",
        ),
        _doc(
            9,
            handle="alice",
            activated=False,
            history=[{"id": 9, "version": None, "timestamp": "2024-06-01T00:00:00.000Z"}],
            tables={
                "contribution": [{"id": 9, "version": None, "contributor": "@alice"}],
                "samples": [{"sample": "S1", "geologic_types": ["Lava", "Flow"]}],
            },
        ),
        _doc(11, handle="ghost", activated=True, history=[]),
    ]
    client = FakeSearch(docs, users)

    report = await legacy_inventory.build_inventory(karar_node, tmp_path, client=client)

    assert client.cleared
    assert (report["contributions"], report["public"], report["private"]) == (3, 1, 1)
    assert (report["from_s3"], report["from_index"], report["owners"]) == (1, 1, 1)
    assert report["unresolved_handles"] == ["ghost"]
    assert [e["id"] for e in report["errors"]] == [11]

    inventory = load_inventory(tmp_path / "inventory.json")
    by_id = {r.id: r for r in inventory.records}
    assert set(by_id) == {7, 9}

    public = by_id[7]
    assert public.owner_email == "alice@example.org"
    assert public.published and public.latest and public.version == 2
    assert public.previous_id is None  # same id in _history: not a version chain
    assert public.created_at.isoformat().startswith("2024-01-01")
    assert public.activated_at.isoformat().startswith("2024-05-02")
    assert public.private_key == "0b6e4e2a-1c8d-4a49-9e5f-3d1c2b4a5f60"
    entry = public.revisions[0].files["karar_contribution_7.txt"]
    assert entry.bucket == "karar-activated-contributions"
    assert entry.sha256 == digest(PUBLIC_TEXT.encode())
    assert public.revisions[0].reference_doi == "10.1029/2023GC011111"

    private = by_id[9]
    assert not private.published and private.activated_at is None
    entry = private.revisions[0].files["karar_contribution_9.txt"]
    assert entry.bucket is None
    exported = (tmp_path / entry.source).read_bytes()
    assert entry.sha256 == digest(exported)
    text = exported.decode()
    assert "tab delimited\tcontribution" in text
    assert "tab delimited\tsamples" in text
    assert "Lava:Flow" in text
    assert text.index("contribution") < text.index("samples")

    owners = json.loads((tmp_path / "owners.json").read_text())
    assert owners == [
        {
            "handle": "alice",
            "email": "alice@example.org",
            "name": "Alice Ng",
            "orcid": "0000-0002-1825-0097",
            "contributions": [7, 9],
        }
    ]
