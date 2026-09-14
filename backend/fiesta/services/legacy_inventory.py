"""Snapshot a node's legacy Meteor platform into an explicit import inventory.

The legacy apps keep one OpenSearch document per contribution (`<id>_0`, updated
in place) with the workflow flags under `summary.contribution` and the full melded
tables under `contribution`; activated contributions also have one text file in
S3 at `<bucket>/<id>/<slug>_contribution_<id>.txt`. Accounts live in the shared
`er_users` index and are referenced by `@handle`.

This module only reads: it writes `inventory.json` (the `fiesta sync-legacy`
contract) and `owners.json` (handle → verified account fields) to a local directory
for review. Ownership is resolved through `er_users`, never guessed; contributions
whose handle has no account are reported and left out of the inventory.
"""

import contextlib
import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

from botocore.exceptions import ClientError
from sqlalchemy import select

from fiesta.db.models import User
from fiesta.db.session import get_sessionmaker
from fiesta.domain.parse import ParsedContribution, export_text
from fiesta.services.legacy import Inventory
from fiesta.services.revisions import digest
from fiesta.storage import Storage

_MISSING = {"NoSuchKey", "NoSuchBucket", "404", "NotFound"}
_DOI = re.compile(r"10\.\d{4,9}/\S+")


def _flag(value) -> bool:
    return str(value).lower() == "true"


def _when(value) -> datetime | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ":".join(_cell(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True)
    return str(value)


def _doi(summary: dict) -> str | None:
    for candidate in (summary.get("reference"), (summary.get("_reference") or {}).get("doi")):
        if isinstance(candidate, str) and (m := _DOI.search(candidate)):
            return m.group(0).rstrip(".,;")
    return None


def export_tables(tables: dict, model: dict) -> str:
    """Serialize the legacy melded JSON (`{table: [rows]}`) to canonical text."""
    parsed = ParsedContribution(
        tables={
            table: [{k: _cell(v) for k, v in row.items()} for row in rows]
            for table, rows in tables.items()
            if isinstance(rows, list) and rows
        }
    )
    return export_text(parsed, model)


async def scan_contributions(client, index: str):
    """Yield every `type: contribution` source document in the legacy index."""
    # Small pages and a long timeout: each hit carries every table of a contribution.
    resp = await client.search(
        index=index,
        scroll="10m",
        size=5,
        body={
            "query": {"term": {"type": "contribution"}},
            "_source": ["summary.contribution", "contribution"],
        },
        request_timeout=300,
    )
    scroll_id = resp.get("_scroll_id")
    try:
        while hits := resp["hits"]["hits"]:
            for hit in hits:
                yield hit["_source"]
            if not scroll_id:
                return
            resp = await client.scroll(scroll_id=scroll_id, scroll="10m", request_timeout=300)
            scroll_id = resp.get("_scroll_id", scroll_id)
    finally:
        if scroll_id:  # best-effort release of the scroll context
            with contextlib.suppress(Exception):
                await client.clear_scroll(scroll_id=scroll_id)


async def lookup_owner(client, users_index: str, handle: str) -> dict | None:
    resp = await client.search(
        index=users_index,
        size=1,
        body={"query": {"term": {"handle.raw": handle.lower()}}},
        request_timeout=60,
    )
    hits = resp["hits"]["hits"]
    if not hits:
        return None
    user = hits[0]["_source"]
    email = (user.get("email") or {}).get("address")
    if not email:
        return None
    name = user.get("name") or {}
    full = " ".join(p for p in (name.get("given"), name.get("family")) if p) or name.get(
        "published"
    )
    return {
        "handle": handle.lower(),
        "email": str(email).lower(),
        "name": full or handle,
        "orcid": (user.get("orcid") or {}).get("id"),
    }


async def _fetch(bucket: str, key: str) -> bytes | None:
    try:
        return await Storage(bucket).get_bytes(key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in _MISSING:
            return None
        raise


async def build_inventory(node, out_dir: Path, *, client=None) -> dict:
    cfg = node.legacy
    if cfg is None:
        raise ValueError(f"{node.node.slug}: no `legacy:` block in the node YAML")
    if client is None:
        from fiesta.search.client import get_opensearch

        client = get_opensearch()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model = node.load_data_model(node.data_model.latest)

    report = {
        "node": node.node.slug,
        "index": cfg.index,
        "contributions": 0,
        "public": 0,
        "private": 0,
        "from_s3": 0,
        "from_index": 0,
        "owners": 0,
        "errors": [],
    }
    owners: dict[str, dict] = {}
    unresolved: dict[str, None] = {}
    records = []

    async for doc in scan_contributions(client, cfg.index):
        summary = (doc.get("summary") or {}).get("contribution") or {}
        try:
            cid = int(summary["id"])
        except (KeyError, TypeError, ValueError):
            report["errors"].append({"id": None, "error": "document without a numeric id"})
            continue
        report["contributions"] += 1
        handle = str(summary.get("contributor") or "").lstrip("@").strip().lower()
        owner = owners.get(handle) if handle else None
        if owner is None and handle and handle not in unresolved:
            owner = await lookup_owner(client, cfg.users_index, handle)
            if owner:
                owners[handle] = owner | {"contributions": []}
            else:
                unresolved[handle] = None
        if handle in owners:
            owners[handle]["contributions"].append(cid)
        else:
            report["errors"].append(
                {"id": cid, "error": f"no account for contributor {handle or '(blank)'!r}"}
            )
            continue

        history = [h for h in summary.get("_history") or [] if isinstance(h, dict)]
        stamps = [t for t in (_when(h.get("timestamp")) for h in history) if t]
        created = min(stamps) if stamps else _when(summary.get("timestamp"))
        if created is None:
            report["errors"].append({"id": cid, "error": "no usable timestamp"})
            continue
        published = _flag(summary.get("_is_activated"))
        activated = _when(summary.get("timestamp")) if published else None
        previous = None
        if len(history) > 1:
            try:
                prev = int(history[1].get("id"))
                previous = prev if prev != cid else None
            except (TypeError, ValueError):
                previous = None
        try:
            version = int(summary.get("version") or 1)
        except (TypeError, ValueError):
            version = 1
        private_key = None
        with contextlib.suppress(TypeError, ValueError):
            private_key = str(uuid.UUID(str(summary.get("_private_key"))))

        canonical = cfg.canonical.format(slug=node.node.slug, id=cid)
        key = f"{cid}/{canonical}"
        entry = None
        for bucket in cfg.buckets:
            raw = await _fetch(bucket, key)
            if raw is not None:
                entry = {"source": key, "bucket": bucket, "sha256": digest(raw)}
                report["from_s3"] += 1
                break
        if entry is None:
            tables = doc.get("contribution") or {}
            if not isinstance(tables, dict) or not tables:
                report["errors"].append({"id": cid, "error": "no S3 object and no indexed tables"})
                continue
            text = export_tables(tables, model).encode()
            local = out_dir / "files" / str(cid) / canonical
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_bytes(text)
            entry = {"source": f"files/{cid}/{canonical}", "sha256": digest(text)}
            report["from_index"] += 1

        report["public" if published else "private"] += 1
        records.append(
            {
                "id": cid,
                "owner_email": owners[handle]["email"],
                "version": max(version, 1),
                "previous_id": previous,
                "published": published,
                "latest": summary.get("_is_latest") is None or _flag(summary.get("_is_latest")),
                "created_at": created.isoformat(),
                "activated_at": activated.isoformat() if activated else None,
                "private_key": private_key,
                "revisions": [
                    {
                        "key": "legacy",
                        "timestamp": (activated or created).isoformat(),
                        "canonical": canonical,
                        "reference_doi": _doi(summary),
                        "files": {canonical: entry},
                    }
                ],
            }
        )

    inventory = Inventory.model_validate(
        {"format": 1, "node": node.node.slug, "source_id": cfg.source_id, "records": records}
    )
    (out_dir / "inventory.json").write_text(inventory.model_dump_json(indent=2, exclude_none=True))
    (out_dir / "owners.json").write_text(
        json.dumps(sorted(owners.values(), key=lambda o: o["handle"]), indent=2)
    )
    report["owners"] = len(owners)
    report["unresolved_handles"] = sorted(unresolved)
    report["inventory"] = str(out_dir / "inventory.json")
    return report


async def ensure_owners(node, owners: list[dict], *, apply=False) -> dict:
    """Create the shared accounts an inventory needs, without passwords.

    Existing accounts (by email) are left untouched; a legacy handle or ORCID that
    another account already holds is dropped rather than reassigned.
    """
    report = {"existing": 0, "created": 0, "planned": [], "errors": []}
    async with get_sessionmaker(node.node.slug)() as session:
        for owner in owners:
            email = owner["email"].lower()
            user = (
                await session.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()
            if user:
                report["existing"] += 1
                continue
            report["planned"].append(email)
            if not apply:
                continue
            handle = owner.get("handle")
            if (
                handle
                and (
                    await session.execute(select(User).where(User.handle == handle))
                ).scalar_one_or_none()
            ):
                handle = None
            orcid = owner.get("orcid")
            if (
                orcid
                and (
                    await session.execute(select(User).where(User.orcid == orcid))
                ).scalar_one_or_none()
            ):
                orcid = None
            session.add(
                User(email=email, name=owner.get("name") or email, handle=handle, orcid=orcid)
            )
            report["created"] += 1
        if apply:
            await session.commit()
    return report
