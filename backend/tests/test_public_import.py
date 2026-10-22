"""Offline checks of the public-contribution importer's inventory (no network, no DB)."""

import httpx

from fiesta.services.legacy import load_inventory
from fiesta.services.public_import import build_inventory, source_id
from fiesta.services.revisions import digest

SOURCE = "https://fiesta.example.test"
CHAIN = [(15860, 6, False), (18742, 7, False), (20818, 8, True)]


def _summary(cid, version, latest):
    return {
        "type": "contribution",
        "summary": {
            "contribution": {
                "id": cid,
                "version": version,
                "timestamp": "2025-02-28T19:08:01.443000+00:00",
                "data_model_version": "3.0",
                "reference": "10.1029/2000GL000001",
                "_is_activated": True,
                "_is_latest": latest,
            }
        },
    }


def _handler(request):
    parts = request.url.path.split("/")  # /v2/magic/contributions/{id}[/...]
    cid = int(parts[4])
    if cid not in {c for c, _, _ in CHAIN}:
        return httpx.Response(404, json={"detail": f"contribution {cid} not found"})
    if parts[-1] == "versions":
        return httpx.Response(200, json=[{"id": c, "version": v} for c, v, _ in CHAIN])
    if parts[-1] == "download":
        return httpx.Response(
            200,
            content=f"tab\tcontribution\n{cid}\n".encode(),
            headers={"content-disposition": f'attachment; filename="magic_contribution_{cid}.txt"'},
        )
    return httpx.Response(200, json=_summary(*next(c for c in CHAIN if c[0] == cid)))


async def _build(tmp_path, ids, **kwargs):
    async with httpx.AsyncClient(transport=httpx.MockTransport(_handler)) as http:
        report = await build_inventory(
            "magic", ids, tmp_path, source=SOURCE, owner_email="dev@ex.test", http=http, **kwargs
        )
    return report, load_inventory(tmp_path / "inventory.json")


async def test_requested_ids_link_only_to_imported_versions(tmp_path):
    report, inventory = await _build(tmp_path, [20818, 18742, 1234, 20818])
    assert inventory.source_id == source_id(SOURCE) == "public:fiesta.example.test"
    assert report["errors"] == [{"id": 1234, "error": f"not a public contribution on {SOURCE}"}]
    records = {r.id: r for r in inventory.records}
    assert set(records) == {20818, 18742}
    assert records[20818].previous_id == 18742 and records[20818].latest
    assert records[18742].previous_id is None and not records[18742].latest
    rev = records[20818].revisions[0]
    assert rev.canonical == "magic_contribution_20818.txt"
    assert rev.reference_doi == "10.1029/2000GL000001"
    raw = (tmp_path / rev.files[rev.canonical].source).read_bytes()
    assert rev.files[rev.canonical].sha256 == digest(raw)


async def test_versions_imports_the_whole_chain(tmp_path):
    _, inventory = await _build(tmp_path, [20818], versions=True)
    assert [(r.id, r.version, r.previous_id) for r in inventory.records] == [
        (15860, 6, None),
        (18742, 7, 15860),
        (20818, 8, 18742),
    ]


async def test_local_ids_are_never_overwritten(tmp_path):
    report, inventory = await _build(tmp_path, [18742], local_ids={18742})
    assert inventory.records == [] and report["errors"][0]["id"] == 18742
    # An earlier import from the same source is refreshed, and its successor links to it.
    _, inventory = await _build(tmp_path, [20818], local_ids={18742}, imported_ids={18742})
    assert inventory.records[0].previous_id == 18742
