"""Immutable content snapshots. Postgres commits pointers and outbox atomically."""

import hashlib
import json
import uuid
from pathlib import PurePosixPath

from fastapi import HTTPException
from sqlalchemy import select

from fiesta.db.models import AuditEvent, Contribution, ContributionStatus, Outbox, Revision, utcnow
from fiesta.storage import Storage


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def fingerprint(value) -> str:
    return digest(json.dumps(value, sort_keys=True, default=str).encode())


def safe_name(name: str) -> str:
    if (
        not name
        or name in {".", ".."}
        or name != PurePosixPath(name).name
        or "\\" in name
        or any(ord(c) < 32 for c in name)
    ):
        raise HTTPException(422, "file name must be a plain filename")
    return name


async def locked(session, contribution_id):
    return (
        await session.execute(
            select(Contribution)
            .where(Contribution.id == contribution_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


def enqueue(session, contribution, kind="process"):
    contribution.indexing_status = "pending"
    session.add(
        Outbox(contribution_id=contribution.id, revision_id=contribution.head_revision, kind=kind)
    )


async def snapshot_for(session, contribution):
    if contribution.head_revision:
        return (await session.get(Revision, contribution.head_revision)).snapshot
    return {
        "files": {},
        "canonical": contribution.filename,
        "reference_doi": contribution.reference_doi,
        "data_model_version": contribution.data_model_version,
    }


async def save_revision(
    session,
    node,
    contribution,
    actor_id,
    *,
    expected_revision,
    request_key,
    files=None,
    remove=None,
    canonical=None,
    reference_doi=None,
    operation="save",
    restore=None,
    allow_published=False,
    source_timestamp=None,
):
    if not request_key or len(request_key) > 128:
        raise HTTPException(422, "an idempotency key of 1–128 characters is required")
    files = dict(files or {})
    remove = remove or []
    for name in [*files, *remove]:
        safe_name(name)
    request_hash = fingerprint(
        {
            "expected": expected_revision,
            "operation": operation,
            "files": {n: digest(b) for n, b in files.items()},
            "remove": remove,
            "canonical": canonical,
            "reference": reference_doi,
            "restore": restore,
        }
    )
    contribution = await locked(session, contribution.id)
    previous = (
        await session.execute(
            select(Revision).where(
                Revision.contribution_id == contribution.id, Revision.request_key == request_key
            )
        )
    ).scalar_one_or_none()
    if previous:
        if previous.request_hash != request_hash or previous.actor_id != actor_id:
            raise HTTPException(409, "idempotency key was used for a different operation")
        return previous
    if contribution.deleted_at:
        raise HTTPException(404, "contribution not found")
    if contribution.published_revision and not allow_published:
        raise HTTPException(409, "published content is immutable; create a new version")
    if contribution.head_revision != expected_revision:
        raise HTTPException(409, "contribution changed; reload before saving")
    snapshot = json.loads(json.dumps(await snapshot_for(session, contribution)))
    if restore:
        source = await session.get(Revision, restore)
        if source is None or source.contribution_id != contribution.id:
            raise HTTPException(404, "revision not found")
        snapshot = json.loads(json.dumps(source.snapshot))
    storage = Storage.for_node(node)
    # Preserve the existing file when upgrading a pre-revision contribution.
    if not contribution.head_revision and contribution.filename:
        from fiesta.storage import file_key

        raw = await storage.get_bytes(file_key(contribution.id, contribution.filename))
        files = {contribution.filename: raw, **files}
    if canonical is not None:
        snapshot["canonical"] = safe_name(canonical)
    canonical_bytes = files.get(snapshot["canonical"])
    if canonical_bytes:
        import re

        from fiesta.domain.parse import ParseError, parse_text, stamp_ids
        from fiesta.domain.validate import guess_data_model_version

        try:
            text = canonical_bytes.decode("utf-8")
            parsed = parse_text(text)
            snapshot["data_model_version"] = guess_data_model_version(node, parsed)
            # Every write path (upload, editing, /v1, legacy import, new version)
            # stores the canonical file with its download-only identifiers.
            model = node.load_data_model(snapshot["data_model_version"])
            files[snapshot["canonical"]] = stamp_ids(text, contribution.id, model).encode()
            rows = parsed.tables.get("contribution", [])
            reference = rows[0].get("reference", "") if rows else ""
            if (
                reference_doi is None
                and not snapshot["reference_doi"]
                and re.match(r"^10\.\S+/\S+$", reference)
            ):
                snapshot["reference_doi"] = reference
        except (ParseError, UnicodeDecodeError):
            pass  # Invalid drafts are still saved and receive a validation report.
    for name, data in files.items():
        key = f"contributions/{contribution.id}/blobs/{digest(data)}/{name}"
        if not await storage.exists(key):
            await storage.put_bytes(key, data, content_type="application/octet-stream")
        snapshot["files"][name] = {"key": key, "sha256": digest(data), "size": len(data)}
    for name in remove:
        snapshot["files"].pop(name, None)
    if snapshot["canonical"] and snapshot["canonical"] not in snapshot["files"]:
        raise HTTPException(422, "the canonical file cannot be missing")
    if reference_doi is not None:
        snapshot["reference_doi"] = reference_doi
    from fiesta.services.references import request

    # Its publication metadata is fetched by the outbox worker.
    await request(session, snapshot["reference_doi"])
    revision = Revision(
        id=str(uuid.uuid4()),
        contribution_id=contribution.id,
        parent_id=contribution.head_revision,
        actor_id=actor_id,
        operation=operation,
        request_key=request_key,
        request_hash=request_hash,
        snapshot=snapshot,
        created_at=source_timestamp or utcnow(),
    )
    await storage.put_json(
        f"contributions/{contribution.id}/revisions/{revision.id}/manifest.json",
        {
            "id": revision.id,
            "parent_id": revision.parent_id,
            "actor_id": actor_id,
            "operation": operation,
            "created_at": revision.created_at.isoformat(),
            "snapshot": snapshot,
        },
    )
    session.add(revision)
    contribution.head_revision = revision.id
    contribution.filename = snapshot["canonical"]
    contribution.reference_doi = snapshot["reference_doi"]
    contribution.data_model_version = snapshot["data_model_version"]
    contribution.status = ContributionStatus.UPLOADED
    contribution.error = None
    session.add(
        AuditEvent(
            contribution_id=contribution.id,
            actor_id=actor_id,
            operation=operation,
            details={"revision_id": revision.id},
        )
    )
    enqueue(session, contribution)
    await session.flush()
    return revision


async def revision_file(session, node, contribution, name=None, revision_id=None):
    rev = await session.get(Revision, revision_id or contribution.head_revision)
    if rev is None or rev.contribution_id != contribution.id:
        raise HTTPException(404, "revision not found")
    name = name or rev.snapshot["canonical"]
    entry = rev.snapshot["files"].get(name)
    if entry is None:
        raise HTTPException(404, "file not found")
    raw = await Storage.for_node(node).get_bytes(entry["key"])
    if digest(raw) != entry["sha256"]:
        raise RuntimeError("stored file checksum does not match revision")
    return raw


async def stamp_ids_revision(session, node, contribution, *, apply=True):
    """Backfill a stored canonical file that predates `stamp_ids`: save it again
    (a new revision, history kept) so it gains its download-only identifiers.
    A published contribution's pointer and a legacy-import checkpoint follow the
    new head, so the contribution stays published and re-syncable. Returns True
    when the file needs (or received) the identifiers."""
    from fiesta.db.models import LegacyImport
    from fiesta.domain.parse import ParseError, parse_text, stamp_ids
    from fiesta.domain.validate import guess_data_model_version

    head = contribution.head_revision
    if not head or contribution.deleted_at:
        return False
    raw = await revision_file(session, node, contribution)
    try:
        text = raw.decode("utf-8")
        model = node.load_data_model(guess_data_model_version(node, parse_text(text)))
    except (ParseError, UnicodeDecodeError):
        return False  # stored as sent; the validation report already says why
    if stamp_ids(text, contribution.id, model) == text:
        return False
    if not apply:
        return True
    published = contribution.published_revision == head
    name = (await session.get(Revision, head)).snapshot["canonical"]
    revision = await save_revision(
        session,
        node,
        contribution,
        contribution.contributor_id,
        expected_revision=head,
        request_key=f"stamp-ids:{head}",
        files={name: raw},
        canonical=name,
        operation="stamp-ids",
        allow_published=True,
    )
    if published:
        contribution.published_revision = revision.id
    checkpoints = await session.execute(
        select(LegacyImport).where(
            LegacyImport.contribution_id == contribution.id, LegacyImport.revision_id == head
        )
    )
    for checkpoint in checkpoints.scalars():
        checkpoint.revision_id = revision.id
    return True
