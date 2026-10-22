"""Copy public contributions from a FIESTA deployment into local development.

Needs no credentials: it reads only what `GET /v2/{node}/contributions/{id}`
serves publicly, writes a local-file inventory and applies it with
`sync_inventory`, so imports keep their public IDs, versions and DOIs, a re-run
is idempotent, and the outbox processes them like any other revision.
"""

import hashlib
import json
import re
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import select

from fiesta.db.models import Contribution, LegacyImport
from fiesta.db.session import get_sessionmaker
from fiesta.services.legacy import sync_inventory
from fiesta.services.seed import ensure_accounts, load_seed, require_local

DEFAULT_SOURCE = "https://dev.earthref.org"


def source_id(source):
    return f"public:{urlparse(source).hostname}"


def _filename(response, slug, cid):
    match = re.search(r'filename="?([^";]+)"?', response.headers.get("content-disposition", ""))
    return Path(match.group(1)).name if match else f"{slug}_contribution_{cid}.txt"


async def build_inventory(
    slug,
    ids,
    out_dir,
    *,
    source,
    owner_email,
    http,
    versions=False,
    local_ids=frozenset(),
    imported_ids=frozenset(),
):
    """Write OUT_DIR/inventory.json and the canonical file of each public ID (with
    VERSIONS, also the earlier published versions of its chain). LOCAL_IDS are the
    destination's contributions; IMPORTED_IDS those earlier runs from SOURCE made."""
    api = f"{source.rstrip('/')}/v2/{slug}/contributions"
    out_dir = Path(out_dir)
    report = {"records": 0, "bytes": 0, "errors": []}
    previous = {}  # target ID -> the version before it in its public chain
    for cid in dict.fromkeys(ids):
        response = await http.get(f"{api}/{cid}/versions")
        if response.status_code == 404:
            report["errors"].append({"id": cid, "error": f"not a public contribution on {source}"})
            continue
        response.raise_for_status()
        chain = [v["id"] for v in response.json()]
        at = chain.index(cid)
        for i in range(at + 1) if versions else [at]:
            previous.setdefault(chain[i], chain[i - 1] if i else None)
    fetched = {}
    for cid in previous:
        if cid in local_ids and cid not in imported_ids:
            report["errors"].append(
                {
                    "id": cid,
                    "error": "already a local contribution (a `make seed` fixture or an "
                    "upload); import public IDs before seeding, or into a fresh stack",
                }
            )
            continue
        response = await http.get(f"{api}/{cid}")
        response.raise_for_status()
        summary = response.json()["summary"]["contribution"]
        async with http.stream("GET", f"{api}/{cid}/download") as response:
            response.raise_for_status()
            name = _filename(response, slug, cid)
            path = out_dir / "files" / str(cid) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            sha = hashlib.sha256()
            with path.open("wb") as f:
                async for chunk in response.aiter_bytes():
                    f.write(chunk)
                    sha.update(chunk)
                    report["bytes"] += len(chunk)
        fetched[cid] = (summary, name, sha.hexdigest())
    records = []
    for cid, (summary, name, sha) in fetched.items():
        prior = previous[cid]
        activated = bool(summary.get("_is_activated"))
        records.append(
            {
                "id": cid,
                "owner_email": owner_email,
                "version": summary.get("version") or 1,
                # A version links to its predecessor only when that is (or was) imported.
                "previous_id": prior if prior in fetched or prior in imported_ids else None,
                "published": activated,
                "latest": bool(summary.get("_is_latest")),
                "created_at": summary["timestamp"],
                "activated_at": summary["timestamp"] if activated else None,
                "data_model_version": summary.get("data_model_version"),
                "revisions": [
                    {
                        "key": f"public:{cid}",
                        "canonical": name,
                        "files": {name: {"source": f"files/{cid}/{name}", "sha256": sha}},
                        "reference_doi": summary.get("reference") or None,
                        "timestamp": summary["timestamp"],
                    }
                ],
            }
        )
    inventory = {"format": 1, "node": slug, "source_id": source_id(source), "records": records}
    (out_dir / "inventory.json").write_text(json.dumps(inventory, indent=2))
    report["records"] = len(records)
    return report


async def import_public(node, ids, *, source=None, versions=False):
    """Import public IDs from SOURCE as the node's seed workspace owner, then process them."""
    import httpx

    from fiesta.services.outbox import drain

    require_local()
    source = source or DEFAULT_SOURCE
    slug = node.node.slug
    _, manifest = load_seed(node)
    async with get_sessionmaker(slug)() as session:
        users = await ensure_accounts(session, manifest)
        owner_email = users[manifest["workspace"]["owner"]].email
        local_ids = set((await session.execute(select(Contribution.id))).scalars())
        imported_ids = set(
            (
                await session.execute(
                    select(LegacyImport.contribution_id).where(
                        LegacyImport.source_id.startswith(f"{source_id(source)}:")
                    )
                )
            ).scalars()
        )
        await session.commit()
    with tempfile.TemporaryDirectory() as tmp:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60, read=600), follow_redirects=True
        ) as http:
            report = await build_inventory(
                slug,
                ids,
                tmp,
                source=source,
                owner_email=owner_email,
                http=http,
                versions=versions,
                local_ids=local_ids,
                imported_ids=imported_ids,
            )
        if report["records"]:
            synced = await sync_inventory(node, f"{tmp}/inventory.json", apply=True)
            report["applied"], report["unchanged"] = synced["applied"], synced["unchanged"]
            report["errors"] += synced["errors"]
    # A running worker may claim some of these events first; it finishes those itself.
    report["processed"] = await drain(node, limit=1000)
    return report
