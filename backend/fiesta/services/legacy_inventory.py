"""Snapshot a node's legacy Meteor platform into an explicit import inventory.

The legacy apps keep one OpenSearch document per contribution (`<id>_0`, updated
in place) with the workflow flags under `summary.contribution` and the full melded
tables under `contribution`; activated contributions also have one text file in
S3 at `<bucket>/<id>/<slug>_contribution_<id>.txt`. Accounts live in the shared
`er_users` index and are referenced by `@handle`.

This module only reads: it writes `inventory.json` (the `fiesta sync-legacy`
contract), `owners.json` (handle → verified account fields) and `hashes.json` (a
cache of object checksums keyed by ETag and size, so a re-run only downloads
changed objects) to a local directory for review. Ownership is resolved through
`er_users`, never guessed; contributions whose handle has no account are reported
and left out of the inventory.
"""

import asyncio
import contextlib
import hashlib
import json
import re
import sys
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
    """Yield the `summary.contribution` of every contribution document in the index.

    Tables are not fetched here (a MagIC contribution can be hundreds of MB);
    `fetch_tables` loads them per id only when no S3 object exists.
    """
    resp = await client.search(
        index=index,
        scroll="10m",
        size=200,
        body={
            "query": {"term": {"type": "contribution"}},
            "_source": ["summary.contribution"],
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


async def fetch_tables(client, index: str, cid: int) -> dict | None:
    """The melded `{table: [rows]}` JSON stored on the contribution document."""
    resp = await client.search(
        index=index,
        size=1,
        body={
            "query": {
                "bool": {
                    "must": [
                        {"term": {"type": "contribution"}},
                        {"term": {"summary.contribution.id": cid}},
                    ]
                }
            },
            "_source": ["contribution"],
        },
        request_timeout=600,
    )
    hits = resp["hits"]["hits"]
    return hits[0]["_source"].get("contribution") if hits else None


_FALLBACK_HANDLE = re.compile(r"^(?:user)?(\d+)$")


async def lookup_owner(client, users_index: str, handle: str) -> dict | None:
    """Resolve `@handle` through er_users. `user<N>` (or a bare `<N>`) is the legacy
    apps' display fallback for an account with no handle, so it resolves by account
    id; a handle that is itself an email address resolves by email. Anything else
    must match `handle.raw` exactly."""
    handle = handle.lower()
    queries = [{"term": {"handle.raw": handle}}]
    if m := _FALLBACK_HANDLE.match(handle):
        queries.append({"term": {"id": int(m.group(1))}})
    if "@" in handle:
        queries.append({"term": {"email.address.raw": handle}})
    return await _owner_from_query(client, users_index, handle, queries)


async def lookup_owner_by_email(client, users_index: str, email: str) -> dict | None:
    email = email.lower()
    return await _owner_from_query(
        client, users_index, email, [{"term": {"email.address.raw": email}}]
    )


async def _owner_from_query(client, users_index: str, handle: str, queries: list) -> dict | None:
    hits = []
    for query in queries:
        resp = await client.search(
            index=users_index, size=1, body={"query": query}, request_timeout=60
        )
        hits = resp["hits"]["hits"]
        if hits:
            break
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
        "handle": user.get("handle") or None,  # None: the account never chose one
        "email": str(email).lower(),
        "name": full or handle,
        "orcid": (user.get("orcid") or {}).get("id") or None,  # "" is not unique
    }


class HashCache:
    """sha256 per (bucket, key) remembered with the ETag and size it was computed for."""

    def __init__(self, path: Path):
        self.path = path
        self.entries: dict[str, dict] = {}
        if path.is_file():
            with contextlib.suppress(ValueError):
                self.entries = json.loads(path.read_text())
        self.dirty = 0

    def get(self, bucket: str, key: str, etag: str, size: int) -> str | None:
        hit = self.entries.get(f"{bucket}/{key}")
        if hit and hit.get("etag") == etag and hit.get("size") == size:
            return hit["sha256"]
        return None

    def put(self, bucket: str, key: str, etag: str, size: int, sha256: str) -> None:
        self.entries[f"{bucket}/{key}"] = {"etag": etag, "size": size, "sha256": sha256}
        self.dirty += 1
        if self.dirty >= 50:  # an interrupted long run keeps most of its work
            self.save()

    def save(self) -> None:
        if self.dirty:
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self.entries, indent=0, sort_keys=True))
            tmp.replace(self.path)
            self.dirty = 0


async def _head(bucket: str, key: str) -> tuple[str, int] | None:
    try:
        async with Storage(bucket).client() as s3:
            head = await s3.head_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in _MISSING:
            return None
        raise
    return head.get("ETag", "").strip('"'), int(head.get("ContentLength", 0))


async def _hash_object(bucket: str, key: str) -> str:
    """sha256 of an object streamed in chunks (never the whole body in memory)."""
    h = hashlib.sha256()
    async with Storage(bucket).client() as s3:
        obj = await s3.get_object(Bucket=bucket, Key=key)
        async for chunk in obj["Body"].iter_chunks(8 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def _handle_for(cfg, cid: int, summary: dict) -> str:
    """The owner key for a contribution: `override:<email>` when the operator mapped
    this id or its legacy display name explicitly, else its `@handle`, else the
    operator's default owner for published records. Private records without a
    handle stay unowned (quarantined)."""
    if cid in cfg.owner_overrides:
        return f"override:{cfg.owner_overrides[cid].lower()}"
    handle = str(summary.get("contributor") or "").lstrip("@").strip().lower()
    if handle:
        return handle
    name = str(summary.get("_contributor") or "").strip()
    if name and name in cfg.owner_names:
        return f"override:{cfg.owner_names[name].lower()}"
    if cfg.default_owner and _flag(summary.get("_is_activated")):
        return f"override:{cfg.default_owner.lower()}"
    return ""


async def build_inventory(node, out_dir: Path, *, client=None, concurrency: int = 8) -> dict:
    cfg = node.legacy
    if cfg is None:
        raise ValueError(f"{node.node.slug}: no `legacy:` block in the node YAML")
    if client is None:
        from fiesta.search.client import get_opensearch

        client = get_opensearch()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model = node.load_data_model(node.data_model.latest)
    cache = HashCache(out_dir / "hashes.json")

    report = {
        "node": node.node.slug,
        "index": cfg.index,
        "contributions": 0,
        "public": 0,
        "private": 0,
        "from_s3": 0,
        "from_index": 0,
        "cached_hashes": 0,
        "orphaned_previous": 0,
        "owners": 0,
        "errors": [],
    }
    owners: dict[str, dict] = {}
    unresolved: set[str] = set()
    summaries: dict[int, dict] = {}

    # 1. Scan summaries (small) and resolve owners once per handle.
    async for doc in scan_contributions(client, cfg.index):
        summary = (doc.get("summary") or {}).get("contribution") or {}
        try:
            cid = int(summary["id"])
        except (KeyError, TypeError, ValueError):
            report["errors"].append({"id": None, "error": "document without a numeric id"})
            continue
        report["contributions"] += 1
        summaries[cid] = summary
        handle = _handle_for(cfg, cid, summary)
        if handle and handle not in owners and handle not in unresolved:
            if handle.startswith("override:"):
                owner = await lookup_owner_by_email(client, cfg.users_index, handle[9:])
            else:
                owner = await lookup_owner(client, cfg.users_index, handle)
            if owner:  # one entry per account, however many keys point at it
                same = next((o for o in owners.values() if o["email"] == owner["email"]), None)
                owners[handle] = same or owner | {"contributions": []}
            else:
                unresolved.add(handle)

    # 2. Files: checksum the S3 object (cached by ETag+size) or export the tables.
    semaphore = asyncio.Semaphore(concurrency)
    lock = asyncio.Lock()

    async def resolve_file(cid: int) -> dict | Exception:
        canonical = cfg.canonical.format(slug=node.node.slug, id=cid)
        key = f"{cid}/{canonical}"
        async with semaphore:
            try:
                for bucket in cfg.buckets:
                    head = await _head(bucket, key)
                    if head is None:
                        continue
                    etag, size = head
                    if cfg.max_file_bytes and size > cfg.max_file_bytes:
                        raise ValueError(f"{bucket}/{key} is {size} bytes, over max_file_bytes")
                    sha = cache.get(bucket, key, etag, size)
                    if sha:
                        async with lock:
                            report["cached_hashes"] += 1
                    else:
                        sha = await _hash_object(bucket, key)
                        async with lock:
                            cache.put(bucket, key, etag, size, sha)
                    return {
                        "canonical": canonical,
                        "entry": {"source": key, "bucket": bucket, "sha256": sha},
                        "origin": "from_s3",
                    }
                tables = await fetch_tables(client, cfg.index, cid) or {}
                if not isinstance(tables, dict) or not tables:
                    raise ValueError("no S3 object and no indexed tables")
                text = export_tables(tables, model).encode()
                local = out_dir / "files" / str(cid) / canonical
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_bytes(text)
                return {
                    "canonical": canonical,
                    "entry": {"source": f"files/{cid}/{canonical}", "sha256": digest(text)},
                    "origin": "from_index",
                }
            except Exception as exc:  # noqa: BLE001 — reported per contribution
                return exc

    ids = sorted(summaries)
    done = 0

    async def tracked(cid: int):
        nonlocal done
        result = await resolve_file(cid)
        done += 1
        if done % 250 == 0 or done == len(ids):
            print(
                f"{node.node.slug}: {done}/{len(ids)} files resolved", file=sys.stderr, flush=True
            )
        return result

    resolved = dict(zip(ids, await asyncio.gather(*(tracked(cid) for cid in ids)), strict=True))
    cache.save()

    # 3. Assemble records.
    records = []
    for cid in ids:
        summary = summaries[cid]
        handle = _handle_for(cfg, cid, summary)
        if handle not in owners:
            report["errors"].append(
                {"id": cid, "error": f"no account for contributor {handle or '(blank)'!r}"}
            )
            continue
        file = resolved[cid]
        if isinstance(file, Exception):
            report["errors"].append({"id": cid, "error": str(file)})
            continue
        owners[handle]["contributions"].append(cid)

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
            with contextlib.suppress(TypeError, ValueError):
                prev = int(history[1].get("id"))
                if prev != cid:
                    if prev in summaries:
                        previous = prev
                    else:  # parent no longer in the legacy index: keep the record, drop the link
                        report["orphaned_previous"] += 1
        try:
            version = int(summary.get("version") or 1)
        except (TypeError, ValueError):
            version = 1
        private_key = None
        with contextlib.suppress(TypeError, ValueError):
            private_key = str(uuid.UUID(str(summary.get("_private_key"))))
        dmv = str(summary.get("data_model_version") or "")
        report["public" if published else "private"] += 1
        report[file["origin"]] += 1
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
                "data_model_version": dmv if dmv in node.data_model.versions else None,
                "revisions": [
                    {
                        "key": "legacy",
                        "timestamp": (activated or created).isoformat(),
                        "canonical": file["canonical"],
                        "reference_doi": _doi(summary),
                        "files": {file["canonical"]: file["entry"]},
                    }
                ],
            }
        )

    inventory = Inventory.model_validate(
        {"format": 1, "node": node.node.slug, "source_id": cfg.source_id, "records": records}
    )
    (out_dir / "inventory.json").write_text(inventory.model_dump_json(indent=2, exclude_none=True))
    accounts = list({id(o): o for o in owners.values()}.values())
    (out_dir / "owners.json").write_text(
        json.dumps(sorted(accounts, key=lambda o: o["email"]), indent=2)
    )
    report["owners"] = len(accounts)
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
            handle = owner.get("handle") or None
            if (
                handle
                and (
                    await session.execute(select(User).where(User.handle == handle))
                ).scalar_one_or_none()
            ):
                handle = None
            orcid = owner.get("orcid") or None  # "" is not unique; the column is
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
