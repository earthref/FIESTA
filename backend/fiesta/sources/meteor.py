"""Sync a node from its legacy Meteor app (OpenSearch index + S3 archive bucket).

Each run snapshots the source with the same reader as `fiesta legacy-inventory`
(`fiesta.services.legacy_inventory.build_inventory`) into a state directory
(its hash cache means an unchanged S3 object is never downloaded twice), asks
the FIESTA API for the fingerprint of each record it last applied, and sends
only the records whose fingerprint differs, oldest version first.

Records whose legacy owner has no account are quarantined (counted, not
errors) exactly as in the bulk import; a record that disappears from the
source is reported as `missing_from_source` and left alone (absence is never a
deletion).
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from fiesta.services.legacy import SourceRecord, load_inventory, record_fingerprint
from fiesta.services.seed import local_file
from fiesta.sources.client import SourceAPI, SourceAPIError
from fiesta.storage import Storage

QUARANTINE_PREFIX = "no account for contributor"


async def _files(record: SourceRecord, state_dir: Path) -> dict[str, bytes]:
    files = {}
    for revision in record.revisions:
        for name, entry in revision.files.items():
            if entry.bucket:
                body = await Storage(entry.bucket).get_bytes(entry.source, entry.version_id)
            else:  # exported from the indexed tables into the state directory
                body = local_file(state_dir, entry.source).read_bytes()
            files[f"{revision.key}/{name}"] = body
    return files


async def sync_meteor(
    node, api: SourceAPI, state_dir: Path, *, dry_run: bool = False, ids=None, client=None
) -> dict:
    """Mirror NODE's Meteor source through API. IDS limits the run to those
    contribution IDs (the snapshot still covers the whole source)."""
    from fiesta.services.legacy_inventory import build_inventory

    state = await api.state()
    summary = {"node": node.node.slug, "mode": state["mode"], "source_id": state["source_id"]}
    if state["mode"] != "source":
        return summary | {"skipped": "node is in public mode"}
    checkpoints = state["checkpoints"]

    report = await build_inventory(node, state_dir, client=client)
    inventory = load_inventory(state_dir / "inventory.json")
    owners = {o["email"]: o for o in json.loads((state_dir / "owners.json").read_text())}
    quarantined = [e for e in report["errors"] if e["error"].startswith(QUARANTINE_PREFIX)]
    errors = [e for e in report["errors"] if not e["error"].startswith(QUARANTINE_PREFIX)]
    summary |= {
        "source_records": report["contributions"],
        "quarantined": len(quarantined),
        "unresolved_handles": report.get("unresolved_handles", []),
        "unchanged": 0,
        "applied": 0,
        "planned": [],
        "bytes": 0,
    }

    wanted = set(ids or ())
    for record in sorted(inventory.records, key=lambda r: (r.version, r.id)):
        if wanted and record.id not in wanted:
            continue
        if checkpoints.get(str(record.id)) == record_fingerprint(record):
            summary["unchanged"] += 1
            continue
        if dry_run:
            summary["planned"].append(record.id)
            continue
        try:
            files = await _files(record, state_dir)
            owner = owners.get(record.owner_email)
            account = {k: v for k, v in (owner or {}).items() if k != "contributions"}
            result = await api.put_record(record, files, account or None)
        except (SourceAPIError, OSError, ValueError) as exc:
            errors.append({"id": record.id, "error": str(exc)})
            continue
        summary["bytes"] += result["bytes"]
        summary["applied" if result["status"] == "applied" else "unchanged"] += 1

    in_source = {str(r.id) for r in inventory.records}
    summary["missing_from_source"] = sorted((int(i) for i in set(checkpoints) - in_source), key=int)
    summary["errors"] = errors
    return summary


def _report(summary: dict) -> None:
    """Print the summary as the last stdout line and, under the ops worker,
    write the scalar fields its Slack message shows (docs/ops-scheduler.md)."""
    print(json.dumps(summary, default=str), flush=True)
    path = os.environ.get("FIESTA_OPS_SUMMARY_JSON")
    if path:
        scalars = {k: v for k, v in summary.items() if isinstance(v, str | int | float)}
        scalars["errors"] = len(summary.get("errors", []))
        scalars["planned"] = len(summary.get("planned", []))
        Path(path).write_text(json.dumps(scalars))


def main(slug: str, description: str | None = None) -> None:
    """Command line of a Meteor node's `sources/<slug>.py`."""
    parser = argparse.ArgumentParser(description=description or f"Sync {slug} from Meteor.")
    parser.add_argument(
        "--api",
        default=os.environ.get("FIESTA_SOURCE_API", "http://localhost:8000"),
        help="FIESTA API base URL, serving /v2 [env FIESTA_SOURCE_API]",
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path(
            os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"), "fiesta", "sources", slug
        ),
        help="snapshot, hash cache and exported files, kept between runs",
    )
    parser.add_argument(
        "--owner-map",
        type=Path,
        help="JSON of owner_handles/owner_names/owner_overrides/default_owner "
        "(operator-approved owners; never in checked-in config)",
    )
    parser.add_argument("--dry-run", action="store_true", help="report what would be sent")
    parser.add_argument("--ids", type=int, nargs="*", help="only these contribution IDs")
    args = parser.parse_args()

    email = os.environ.get("FIESTA_SOURCE_EMAIL")
    password = os.environ.get("FIESTA_SOURCE_PASSWORD")
    if not email or not password:
        parser.error("set FIESTA_SOURCE_EMAIL and FIESTA_SOURCE_PASSWORD (a node admin account)")

    from fiesta.nodeconfig import get_deployment
    from fiesta.search.client import get_opensearch

    node = get_deployment().node_for(slug)
    if node.legacy is None or node.legacy.kind != "meteor":
        parser.error(f"{slug} has no `legacy: {{kind: meteor}}` block")
    if args.owner_map:
        legacy = node.legacy.with_owner_map(json.loads(args.owner_map.read_text()))
        node = node.model_copy(update={"legacy": legacy})
    args.state_dir.mkdir(parents=True, exist_ok=True)

    async def run() -> dict:
        api = SourceAPI(args.api, node.node.slug)
        try:
            await api.login(email, password)
            return await sync_meteor(
                node, api, args.state_dir.resolve(), dry_run=args.dry_run, ids=args.ids
            )
        finally:
            await api.close()
            await get_opensearch().close()

    summary = asyncio.run(run())
    _report(summary)
    sys.exit(1 if summary.get("errors") else 0)
