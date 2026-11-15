"""Copy public contributions from a FIESTA deployment into local development.

Needs no credentials: it reads only what `GET /v2/{node}/contributions/{id}`
serves publicly, writes a local-file inventory and applies it with
`sync_inventory`, so imports keep their public IDs, versions and DOIs, a re-run
is idempotent, and the outbox processes them like any other revision.

Each import is owned by a local copy of its deployed contributor (name, handle,
ORCID and, when free, user ID, from the public `GET /v2/portal/users`; never an
email or password), so the local Users page and contributor facets match the
deployment. The seed accounts (Local Developer) keep the local fixtures.
"""

import hashlib
import json
import re
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import or_, select, text

from fiesta.db.models import Contribution, LegacyImport, User
from fiesta.db.session import get_sessionmaker
from fiesta.services.legacy import load_inventory, sync_inventory
from fiesta.services.seed import ensure_accounts, load_seed, require_local
from fiesta.settings import get_settings

DEFAULT_SOURCE = "https://dev.earthref.org"


def source_id(source):
    return f"public:{urlparse(source).hostname}"


def contributor_email(source, remote_id):
    """The local account address of SOURCE's user REMOTE_ID: deployed emails are not
    public, and `.invalid` can never receive mail."""
    return f"user-{remote_id}@{urlparse(source).hostname}.invalid"


class Contributors:
    """`await contributors(summary)`: the local account email for a deployment
    contributor (`summary._contributor_id`), the account created on first use. A
    contributor already here under the same ORCID or handle (e.g. from a legacy
    sync) is reused; a new account takes the deployment's user ID when that ID is
    free locally, and has no password, so it cannot log in. Summaries without a
    contributor ID go to FALLBACK_EMAIL."""

    def __init__(self, session, source, http, fallback_email):
        self.session, self.source, self.http = session, source, http
        self.fallback_email = fallback_email
        self.directory = None  # remote user ID -> {name, handle, orcid}
        self.emails = {}  # remote user ID -> local email
        self.report = {"created": 0, "matched": 0, "renumbered": 0}

    async def _load_directory(self):
        self.directory = {}
        url = f"{self.source.rstrip('/')}/v2/portal/users"
        try:
            while True:
                response = await self.http.get(
                    url, params={"limit": 1000, "offset": len(self.directory)}
                )
                if response.status_code == 404:  # a deployment without the portal
                    return
                response.raise_for_status()
                page = response.json()
                self.directory.update({u["id"]: u for u in page["users"]})
                if not page["users"] or len(self.directory) >= page["total"]:
                    return
        except Exception as exc:  # the summaries' names alone still assign owners
            self.report["directory_error"] = repr(exc)

    async def __call__(self, summary):
        remote_id = summary.get("_contributor_id")
        if not isinstance(remote_id, int):
            return self.fallback_email
        if remote_id not in self.emails:
            if self.directory is None:
                await self._load_directory()
            self.emails[remote_id] = await self._ensure(remote_id, summary)
        return self.emails[remote_id]

    async def _ensure(self, remote_id, summary):
        info = self.directory.get(remote_id, {})
        name = info.get("name") or str(summary.get("_contributor") or "").strip()
        handle, orcid = info.get("handle") or None, info.get("orcid") or None
        email = contributor_email(self.source, remote_id)
        session = self.session
        user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is not None:  # an earlier import's account: follow the deployment
            user.name = name or user.name
            for field, value in (("handle", handle), ("orcid", orcid)):
                taken = (
                    value
                    and (
                        await session.execute(
                            select(User.id).where(getattr(User, field) == value, User.id != user.id)
                        )
                    ).first()
                )
                if not taken:
                    setattr(user, field, value)
            await session.commit()
            return email
        same = [User.orcid == orcid] if orcid else []
        same += [User.handle == handle] if handle else []
        if same:
            match = (
                (await session.execute(select(User).where(or_(*same)).order_by(User.id)))
                .scalars()
                .first()
            )
            if match is not None:
                self.report["matched"] += 1
                return match.email
        free = await session.get(User, remote_id) is None
        session.add(
            User(
                **({"id": remote_id} if free else {}),
                email=email,
                name=name or f"User {remote_id}",
                handle=handle,
                orcid=orcid,
                password_hash=None,
                settings={},
            )
        )
        await session.flush()
        if free:  # keep generated IDs clear of the imported ones
            table = f'"{get_settings().db_shared_schema}".users'
            await session.execute(
                text(
                    "SELECT setval(pg_get_serial_sequence(:table, 'id'), "
                    f"GREATEST((SELECT MAX(id) FROM {table}), 1))"
                ),
                {"table": table},
            )
        else:
            self.report["renumbered"] += 1
        await session.commit()
        self.report["created"] += 1
        return email


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
    skip_local=False,
    owner_for=None,
    local_owners=None,
):
    """Write OUT_DIR/inventory.json and the canonical file of each public ID (with
    VERSIONS, also the earlier published versions of its chain). LOCAL_IDS are the
    destination's contributions; IMPORTED_IDS those earlier runs from SOURCE made.
    A record's owner is `await OWNER_FOR(summary)` (an email), else OWNER_EMAIL.
    With SKIP_LOCAL, an ID already local is counted under `skipped`, not fetched,
    unless it is an earlier import whose owner in LOCAL_OWNERS (ID -> email) is not
    OWNER_FOR's: that one is fetched again so the import reassigns it (`reassigned`)."""
    api = f"{source.rstrip('/')}/v2/{slug}/contributions"
    out_dir = Path(out_dir)
    report = {"records": 0, "bytes": 0, "skipped": 0, "reassigned": 0, "errors": []}
    local_owners = local_owners or {}

    async def owner(summary):
        return await owner_for(summary) if owner_for else owner_email

    async def get_summary(cid):
        response = await http.get(f"{api}/{cid}")
        response.raise_for_status()
        return response.json()["summary"]["contribution"]

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
        summary = None
        if skip_local and cid in local_ids:
            if owner_for and cid in imported_ids:
                summary = await get_summary(cid)
                if local_owners.get(cid) == await owner(summary):
                    summary = None
            if summary is None:
                report["skipped"] += 1
                continue
            report["reassigned"] += 1
        if cid in local_ids and cid not in imported_ids:
            report["errors"].append(
                {
                    "id": cid,
                    "error": "already a local contribution (a `make seed` fixture or an "
                    "upload); import public IDs before seeding, or into a fresh stack",
                }
            )
            continue
        summary = summary or await get_summary(cid)
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
        fetched[cid] = (summary, name, sha.hexdigest(), await owner(summary))
    records = []
    for cid, (summary, name, sha, owner_of) in fetched.items():
        prior = previous[cid]
        activated = bool(summary.get("_is_activated"))
        records.append(
            {
                "id": cid,
                "owner_email": owner_of,
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


async def recent_public_ids(slug, count, *, source, http):
    """The IDs of SOURCE's COUNT most recently published public contributions of SLUG
    (latest versions, newest first); none when SOURCE does not serve SLUG."""
    response = await http.get(
        f"{source.rstrip('/')}/v2/{slug}/search/contribution",
        params={"size": count, "sort": "recent"},
    )
    if response.status_code == 404:
        return []
    response.raise_for_status()
    return [r["summary"]["contribution"]["id"] for r in response.json()["results"]]


async def import_recent(node, count, *, source=None):
    """Import SOURCE's COUNT most recent public contributions of NODE that the node
    does not already have (`fiesta seed`)."""
    import httpx

    source = source or DEFAULT_SOURCE
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as http:
            ids = await recent_public_ids(node.node.slug, count, source=source, http=http)
    except httpx.HTTPError as exc:
        return {"records": 0, "errors": [{"error": f"listing {source}: {exc!r}"}]}
    if not ids:
        return {"records": 0, "errors": [], "note": f"no public contributions on {source}"}
    return await import_public(node, ids, source=source, skip_local=True, reassign_seeded=True)


async def import_public(
    node, ids, *, source=None, versions=False, skip_local=False, reassign_seeded=False
):
    """Import public IDs from SOURCE, each owned by a local copy of its deployed
    contributor (`Contributors`), then process them. With SKIP_LOCAL, IDs the node
    already has are left alone unless their owner changed; with REASSIGN_SEEDED,
    earlier imports still owned by a seed account (stacks seeded before imports
    kept their contributors) are checked too."""
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
        local_owners = dict(
            (
                await session.execute(
                    select(LegacyImport.contribution_id, User.email)
                    .join(Contribution, Contribution.id == LegacyImport.contribution_id)
                    .join(User, User.id == Contribution.contributor_id)
                    .where(LegacyImport.source_id.startswith(f"{source_id(source)}:"))
                )
            ).all()
        )
        imported_ids = set(local_owners)
        await session.commit()
        seeded = {u.email for u in users.values()}
        extra = (
            [cid for cid, email in sorted(local_owners.items()) if email in seeded]
            if reassign_seeded
            else []
        )
        with tempfile.TemporaryDirectory() as tmp:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60, read=600), follow_redirects=True
            ) as http:
                contributors = Contributors(session, source, http, owner_email)
                report = await build_inventory(
                    slug,
                    [*ids, *extra],
                    tmp,
                    source=source,
                    owner_email=owner_email,
                    http=http,
                    versions=versions,
                    local_ids=local_ids,
                    imported_ids=imported_ids,
                    skip_local=skip_local,
                    owner_for=contributors,
                    local_owners=local_owners,
                )
            report["contributors"] = contributors.report
            # An earlier import since withdrawn from SOURCE keeps its owner quietly.
            gone = set(extra) - set(ids)
            report["errors"] = [e for e in report["errors"] if e.get("id") not in gone]
            imported = []
            if report["records"]:
                imported = [r.id for r in load_inventory(f"{tmp}/inventory.json").records]
                synced = await sync_inventory(node, f"{tmp}/inventory.json", apply=True)
                report["applied"], report["unchanged"] = synced["applied"], synced["unchanged"]
                report["errors"] += synced["errors"]
    # Only these imports' events: another backlog on the node is the worker's. A
    # running worker may claim some of them first; it finishes those itself.
    report["processed"] = (
        await drain(node, limit=1000, contribution_ids=imported)
        if imported
        else {"completed": 0, "failed": 0}
    )
    return report
