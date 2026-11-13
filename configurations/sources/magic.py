"""MagIC data source: Meteor MagIC (earthref.org/MagIC) -> FIESTA MagIC.

Runs while FIESTA MagIC is in data-source mode (docs/data-sources.md), hourly on
the ops scheduler (configurations/magic.yaml `legacy.sync`, schedule magic-source), from
fiesta/backend/:

    FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... \\
        uv run python ../../configurations/sources/magic.py --api http://localhost:18000 [--dry-run]

Reads the legacy `magic` index and the `magic-activated-contributions`,
`magic-contributions` and `magic-private-contributions` buckets named in
configurations/magic.yaml's `legacy:` block with the FIESTA_OPENSEARCH_* / FIESTA_S3_*
credentials in its environment, and writes through the API as a MagIC node admin.
It continues from the September 2026 bulk import (checkpoints `legacy-magic`), so
a run sends only the contributions created, activated or re-versioned since.

A private key shared across a version chain is handled by the importer (the key
follows the newest version). MagIC's one fix-up of the legacy records,
`heal_chains`, mends version chains Meteor MagIC broke (2026-11-13): a
re-upload of a dataset made as a new contribution instead of a new version
leaves one publication with several "latest" contributions.
"""

from collections import defaultdict

from fiesta.services.legacy import Inventory, SourceRecord
from fiesta.sources.meteor import main


def _doi(record: SourceRecord) -> str:
    return (record.revisions[-1].reference_doi or "").strip().lower()


def _when(record: SourceRecord):
    return record.activated_at or record.created_at


async def _contents(node, client, ids: list[int]) -> dict[int, str]:
    """What each contribution holds, as the legacy index summarizes it: its
    record count at every level and its location names (none when it lists
    no location and no records, too little to call two the same)."""
    if client is None:
        from fiesta.search.client import get_opensearch

        client = get_opensearch()
    levels = node.hierarchy[1:]
    out: dict[int, str] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start : start + 500]
        body = {
            "size": len(chunk),
            "query": {
                "bool": {
                    "filter": [
                        {"term": {"type": "contribution"}},
                        {"terms": {"summary.contribution.id": chunk}},
                    ]
                }
            },
            "_source": [
                "summary.contribution.id",
                "summary._all.location",
                *(f"summary.{level}._n_results" for level in levels),
            ],
        }
        response = await client.search(index=node.legacy.index, body=body, request_timeout=300)
        for hit in response["hits"]["hits"]:
            summary = hit["_source"].get("summary", {})
            counts = [int((summary.get(level) or {}).get("_n_results") or 0) for level in levels]
            locations = sorted({str(x) for x in (summary.get("_all") or {}).get("location") or []})
            if locations or any(counts):
                out[int(summary["contribution"]["id"])] = repr((counts, locations))
    return out


async def heal_chains(node, inventory: Inventory, client=None) -> tuple[Inventory, dict]:
    """Mend the version chains Meteor MagIC broke, in the records sent:

    1. A version another version names as its previous one is not the latest
       (legacy left some flagged latest after a new version).
    2. The latest versions of one publication (reference DOI) that hold the
       same records (every level's count and the location names) are one
       dataset uploaded again as a new contribution: oldest first, each is the
       previous version of the next one's first, and only the newest stays
       latest. The later chain's versions are numbered on from the earlier's.

    Latest versions that differ in what they hold are separate datasets of the
    publication and stay apart (docs/OPERATOR_TODO.md lists them for the MagIC
    team)."""
    records = {r.id: r for r in inventory.records}

    def update(record_id: int, **changes) -> None:
        records[record_id] = records[record_id].model_copy(update=changes)

    # 1. Stale latest flags.
    previous = {r.previous_id for r in records.values() if r.previous_id in records}
    stale = sorted(i for i in previous if records[i].latest)
    for record_id in stale:
        update(record_id, latest=False)

    # 2. One dataset as several chains.
    heads: dict[str, list[SourceRecord]] = defaultdict(list)
    for r in records.values():
        if r.latest and r.published and not r.deleted and _doi(r):
            heads[_doi(r)].append(r)
    shared = {doi: rs for doi, rs in heads.items() if len(rs) > 1}
    contents = await _contents(node, client, [r.id for rs in shared.values() for r in rs])

    def chain(record_id: int) -> list[int]:
        """The versions present from the first to RECORD_ID."""
        ids, seen = [], set()
        while record_id in records and record_id not in seen:
            seen.add(record_id)
            ids.append(record_id)
            record_id = records[record_id].previous_id
        return ids[::-1]

    linked = []
    for rs in shared.values():
        same: dict[str, list[SourceRecord]] = defaultdict(list)
        for r in rs:
            if r.id in contents:
                same[contents[r.id]].append(r)
        for group in same.values():
            group.sort(key=lambda r: (_when(r), r.id))
            for older, newer in zip(group, group[1:], strict=False):
                versions = chain(newer.id)
                update(older.id, latest=False)
                update(versions[0], previous_id=older.id)
                number = records[older.id].version
                for record_id in versions:
                    number = max(records[record_id].version, number + 1)
                    update(record_id, version=number)
                linked.append([older.id, versions[0]])

    healed = inventory.model_copy(update={"records": [records[r.id] for r in inventory.records]})
    return healed, {
        "stale_latest_cleared": len(stale),
        "chains_linked": len(linked),
        "links": linked,
    }


if __name__ == "__main__":
    main("magic", __doc__.splitlines()[0], fixup=heal_chains)
