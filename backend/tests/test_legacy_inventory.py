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
            term = body["query"]["term"]
            if "handle.raw" in term:
                hits = [u for u in self.users.values() if u.get("handle") == term["handle.raw"]]
            elif "id" in term:
                hits = [u for u in self.users.values() if u.get("id") == term["id"]]
            else:
                hits = [
                    u
                    for u in self.users.values()
                    if u["email"]["address"].lower() == term["email.address.raw"]
                ]
            return {"hits": {"hits": [{"_source": u} for u in hits[:1]]}}
        assert index == "karar"
        if "bool" in body["query"]:  # fetch_tables: one contribution's tables by id
            cid = body["query"]["bool"]["must"][1]["term"]["summary.contribution.id"]
            docs = [d for d in self.docs if d["summary"]["contribution"]["id"] == cid]
            assert body["_source"] == ["contribution"]
            return {
                "hits": {"hits": [{"_source": {"contribution": d["contribution"]}} for d in docs]}
            }
        assert body["query"] == {"term": {"type": "contribution"}}
        assert body["_source"] == ["summary.contribution"]
        summaries = [{"_source": {"summary": d["summary"]}} for d in self.docs]
        return {"_scroll_id": "s1", "hits": {"hits": summaries}}

    async def scroll(self, scroll_id, scroll, **kwargs):
        return {"_scroll_id": scroll_id, "hits": {"hits": []}}

    async def clear_scroll(self, scroll_id):
        self.cleared = True


class FakeBody:
    def __init__(self, data):
        self.data = data

    async def iter_chunks(self, size):
        for i in range(0, len(self.data), size):
            yield self.data[i : i + size]


class FakeS3:
    objects = {
        ("karar-activated-contributions", "7/karar_contribution_7.txt"): PUBLIC_TEXT.encode()
    }
    downloads = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def head_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        data = self.objects[(Bucket, Key)]
        return {"ETag": f'"etag-{len(data)}"', "ContentLength": len(data)}

    async def get_object(self, Bucket, Key):
        FakeS3.downloads += 1
        return {"Body": FakeBody(self.objects[(Bucket, Key)])}


class FakeStorage:
    def __init__(self, bucket, prefix=""):
        self.bucket = bucket

    def client(self):
        return FakeS3()


@pytest.mark.asyncio
async def test_build_inventory_from_index_and_buckets(karar_node, tmp_path, monkeypatch):
    monkeypatch.setattr(legacy_inventory, "Storage", FakeStorage)
    users = {
        "alice": {
            "id": 1,
            "handle": "alice",
            "email": {"address": "Alice@Example.org"},
            "name": {"given": "Alice", "family": "Ng"},
            "orcid": {"id": "0000-0002-1825-0097"},
        },
        "42": {  # never chose a handle: the legacy UI shows @user42
            "id": 42,
            "handle": None,
            "email": {"address": "bob@example.org"},
            "name": {"given": "Bob", "family": "Lee"},
        },
        "carol": {
            "id": 7,
            "handle": "carol",
            "email": {"address": "carol@example.org"},
            "name": {"published": "C. Diaz"},
            "orcid": {"id": ""},  # legacy stores "" for no ORCID; must become None
        },
    }
    monkeypatch.setattr(karar_node.legacy, "owner_overrides", {13: "Carol@example.org"})
    monkeypatch.setattr(karar_node.legacy, "owner_names", {"Bob Lee": "bob@example.org"})
    monkeypatch.setattr(karar_node.legacy, "default_owner", "alice@example.org")
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
        _doc(12, handle="user42", activated=True, history=[]),
        _doc(13, handle="", activated=True, history=[]),
        _doc(14, handle="", activated=True, history=[], _contributor="Bob Lee"),  # name map
        _doc(15, handle="", activated=True, history=[]),  # default owner (published)
        _doc(16, handle="", activated=False, history=[]),  # private + no handle: quarantined
        _doc(17, handle="carol@example.org", activated=True, history=[]),  # email as handle
        _doc(18, handle="42", activated=True, history=[]),  # bare account id as handle
        _doc(  # version 2 of 11, whose owner is unresolved: the link is dropped, not dangling
            19,
            handle="alice",
            activated=True,
            history=[
                {"id": 19, "version": 2, "timestamp": "2024-07-02T00:00:00.000Z"},
                {"id": 11, "version": None, "timestamp": "2024-07-01T00:00:00.000Z"},
            ],
            version=2,
        ),
    ]
    for cid in (14, 15, 17, 18, 19):
        FakeS3.objects[("karar-activated-contributions", f"{cid}/karar_contribution_{cid}.txt")] = (
            f"tab delimited\tcontribution\nid\n{cid}\n".encode()
        )
    FakeS3.objects[("karar-contributions", "12/karar_contribution_12.txt")] = (
        b"tab delimited\tcontribution\nid\n12\n"
    )
    FakeS3.objects[("karar-activated-contributions", "13/karar_contribution_13.txt")] = (
        b"tab delimited\tcontribution\nid\n13\n"
    )
    client = FakeSearch(docs, users)

    report = await legacy_inventory.build_inventory(karar_node, tmp_path, client=client)

    assert client.cleared
    assert (report["contributions"], report["public"], report["private"]) == (11, 8, 1)
    assert (report["from_s3"], report["from_index"], report["owners"]) == (8, 1, 3)
    assert report["unresolved_handles"] == ["ghost"]
    assert [e["id"] for e in report["errors"]] == [11, 16]
    assert report["orphaned_previous"] == 1

    inventory = load_inventory(tmp_path / "inventory.json")
    by_id = {r.id: r for r in inventory.records}
    assert set(by_id) == {7, 9, 12, 13, 14, 15, 17, 18, 19}
    assert (
        by_id[17].owner_email == "carol@example.org" and by_id[18].owner_email == "bob@example.org"
    )
    assert by_id[19].version == 2 and by_id[19].previous_id is None  # parent 11 not emitted
    assert by_id[14].owner_email == "bob@example.org"  # display name mapped by the operator
    assert by_id[15].owner_email == "alice@example.org"  # published, default owner
    assert by_id[12].owner_email == "bob@example.org"  # @user42 resolved by account id
    assert by_id[13].owner_email == "carol@example.org"  # operator override, verified in er_users
    assert by_id[12].revisions[0].files["karar_contribution_12.txt"].bucket == "karar-contributions"

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

    # A second run finds the same ETag+size in hashes.json and does not download again.
    downloads = FakeS3.downloads
    again = await legacy_inventory.build_inventory(karar_node, tmp_path, client=client)
    assert again["cached_hashes"] == 8 and FakeS3.downloads == downloads

    owners = json.loads((tmp_path / "owners.json").read_text())
    assert owners == [
        {
            "handle": "alice",
            "email": "alice@example.org",
            "name": "Alice Ng",
            "orcid": "0000-0002-1825-0097",
            "contributions": [7, 9, 15, 19],
        },
        {
            "handle": None,
            "email": "bob@example.org",
            "name": "Bob Lee",
            "orcid": None,
            "contributions": [12, 14, 18],
        },
        {
            "handle": "carol",
            "email": "carol@example.org",
            "name": "C. Diaz",
            "orcid": None,
            "contributions": [13, 17],
        },
    ]


class FakeUsersScroll:
    """er_users in two scroll pages."""

    def __init__(self, users):
        self.pages = [users[:2], users[2:], []]

    async def search(self, index, body, scroll, **kwargs):
        assert index == "er_users" and "_password" in body["_source"]
        return {"_scroll_id": "u1", "hits": {"hits": [{"_source": u} for u in self.pages[0]]}}

    async def scroll(self, scroll_id, scroll, **kwargs):
        self.pages.pop(0)
        return {"_scroll_id": scroll_id, "hits": {"hits": [{"_source": u} for u in self.pages[0]]}}

    async def clear_scroll(self, scroll_id):
        pass


async def test_legacy_accounts_carry_bcrypt_passwords():
    from fiesta.security import hash_password, verify_password

    # bcryptjs writes $2a$; the same hash must verify here.
    legacy_hash = "$2a$" + hash_password("correct horse")[4:]
    users = [
        {
            "id": 3,
            "email": {"address": "Alice@Example.org"},
            "handle": "alice",
            "name": {"given": "Alice", "family": "Ng"},
            "_password": legacy_hash,
        },
        {"id": 4, "handle": "ghost"},  # no email: skipped
        {
            "id": 9,
            "email": {"address": "alice@example.org"},
            "handle": "alice2",
            "_password": "",
        },  # newer duplicate without a password loses
        {
            "id": 5,
            "email": {"address": "bob@example.org"},
            "orcid": {"id": ""},
            "name": {"published": "B. Lee"},
        },
    ]
    accounts, report = await legacy_inventory.legacy_accounts(FakeUsersScroll(users), "er_users")
    assert report == {"documents": 4, "no_email": 1, "duplicate_emails": 1, "no_password": 1}
    alice = accounts["alice@example.org"]
    assert (alice["handle"], alice["name"]) == ("alice", "Alice Ng")
    assert verify_password("correct horse", alice["password_hash"])
    assert not verify_password("wrong", alice["password_hash"])
    assert accounts["bob@example.org"] == {
        "handle": None,
        "email": "bob@example.org",
        "name": "B. Lee",
        "orcid": None,
        "password_hash": None,
    }
