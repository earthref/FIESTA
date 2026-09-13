"""Resumable import of explicit legacy inventory snapshots; never infer ownership.

Each committed source record is its checkpoint. New snapshots may include changed
metadata and explicit tombstones. Absence alone is never interpreted as deletion.
"""

from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import select, text

from fiesta.db.models import AuditEvent, Contribution, LegacyImport, Revision, User
from fiesta.db.session import get_sessionmaker
from fiesta.services.revisions import digest, enqueue, fingerprint, save_revision
from fiesta.services.seed import local_file
from fiesta.storage import Storage


class SourceFile(BaseModel):
    source: str
    bucket: str | None = None
    version_id: str | None = None
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class SourceRevision(BaseModel):
    key: str
    canonical: str
    files: dict[str, SourceFile]
    reference_doi: str | None = None
    timestamp: datetime


class SourceRecord(BaseModel):
    id: int = Field(gt=0)
    owner_email: str
    version: int = Field(default=1, gt=0)
    previous_id: int | None = None
    published: bool = False
    latest: bool = True
    deleted: bool = False
    created_at: datetime
    activated_at: datetime | None = None
    private_key: str | None = None
    revisions: list[SourceRevision] = Field(min_length=1)


class Inventory(BaseModel):
    format: Literal[1]
    node: str
    source_id: str = Field(min_length=1, max_length=120)
    source_bucket: str | None = None
    records: list[SourceRecord]


def load_inventory(path):
    inventory = Inventory.model_validate_json(Path(path).read_text())
    if len({r.id for r in inventory.records}) != len(inventory.records):
        raise ValueError("duplicate contribution IDs in inventory")
    for r in inventory.records:
        if r.previous_id == r.id:
            raise ValueError("a version cannot reference itself")
        if len({v.key for v in r.revisions}) != len(r.revisions):
            raise ValueError("duplicate source revision keys")
    return inventory


async def sync_inventory(node, path, *, apply=False):
    inventory = load_inventory(path)
    if inventory.node != node.node.slug:
        raise ValueError("inventory belongs to another node")
    root = Path(path).parent  # CLI resolves the inventory path before entering async code
    report = {
        "source": inventory.source_id,
        "applied": 0,
        "unchanged": 0,
        "planned": 0,
        "errors": [],
        "bytes": 0,
    }
    source = Storage(inventory.source_bucket) if inventory.source_bucket else None
    for record in sorted(inventory.records, key=lambda r: (r.version, r.id)):
        try:
            source_id = f"{inventory.source_id}:{record.id}"
            record_hash = fingerprint(record.model_dump(mode="json"))
            async with get_sessionmaker(node.node.slug)() as session:
                # One importer per source record; also serializes initial missing-row imports.
                await session.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                    {"key": f"{node.node.slug}:{source_id}"},
                )
                checkpoint = await session.get(LegacyImport, source_id)
                c = await session.get(Contribution, record.id, with_for_update=True)
                if checkpoint and checkpoint.fingerprint == record_hash:
                    report["unchanged"] += 1
                    continue
                if c and (not checkpoint or checkpoint.contribution_id != c.id):
                    raise ValueError("destination ID already belongs to a different contribution")
                if checkpoint and c.head_revision != checkpoint.revision_id:
                    raise ValueError("destination has FIESTA edits; refusing to overwrite")
                if (
                    c
                    and (
                        await session.execute(
                            select(AuditEvent).where(
                                AuditEvent.contribution_id == c.id,
                                AuditEvent.created_at > checkpoint.updated_at,
                                AuditEvent.operation.not_in(["import", "legacy-metadata"]),
                            )
                        )
                    ).first()
                ):
                    raise ValueError("destination workflow changed since import")
                owner = (
                    await session.execute(select(User).where(User.email == record.owner_email))
                ).scalar_one_or_none()
                if owner is None:
                    raise ValueError("owner mapping missing; contribution quarantined from import")
                if (
                    record.previous_id
                    and await session.get(Contribution, record.previous_id) is None
                ):
                    raise ValueError("previous published version must be imported first")
                contents = []
                for rev in record.revisions:
                    if rev.canonical not in rev.files:
                        raise ValueError("canonical file missing from source revision")
                    files = {}
                    for name, entry in rev.files.items():
                        file_source = Storage(entry.bucket) if entry.bucket else source
                        raw = (
                            (await file_source.get_bytes(entry.source, entry.version_id))
                            if file_source
                            else local_file(root, entry.source).read_bytes()
                        )
                        if digest(raw) != entry.sha256:
                            raise ValueError(f"source checksum mismatch: {entry.source}")
                        report["bytes"] += len(raw)
                        files[name] = raw
                    contents.append(files)
                report["planned"] += 1
                if not apply:
                    continue
                if c is None:
                    c = Contribution(
                        id=record.id,
                        node=node.node.slug,
                        contributor_id=owner.id,
                        data_model_version=node.data_model.latest,
                        created_at=record.created_at,
                    )
                    session.add(c)
                    await session.flush()
                c.deleted_at = None
                for source_rev, files in zip(record.revisions, contents, strict=True):
                    key = "import:" + fingerprint(
                        {"source": source_id, "revision": source_rev.model_dump(mode="json")}
                    )
                    existing = (
                        await session.execute(
                            select(Revision).where(
                                Revision.contribution_id == c.id, Revision.request_key == key
                            )
                        )
                    ).scalar_one_or_none()
                    if existing:
                        continue
                    prior = (
                        await session.get(Revision, c.head_revision) if c.head_revision else None
                    )
                    removed = list(set(prior.snapshot["files"]) - set(files)) if prior else []
                    await save_revision(
                        session,
                        node,
                        c,
                        owner.id,
                        expected_revision=c.head_revision,
                        request_key=key,
                        files=files,
                        remove=removed,
                        canonical=source_rev.canonical,
                        reference_doi=source_rev.reference_doi or "",
                        operation="import",
                        allow_published=True,
                        source_timestamp=source_rev.timestamp,
                    )

                c.contributor_id = owner.id
                c.version = record.version
                c.previous_id = record.previous_id
                c.is_activated = record.published and not record.deleted
                c.is_latest = record.latest
                c.activated_at = record.activated_at
                if record.published:
                    c.published_revision = c.head_revision
                if record.private_key:
                    import uuid

                    c.private_key = uuid.UUID(record.private_key)
                if record.deleted:
                    c.deleted_at = datetime.now(UTC)
                now = datetime.now(UTC)
                session.add(
                    AuditEvent(
                        contribution_id=c.id,
                        actor_id=owner.id,
                        operation="legacy-metadata",
                        details=record.model_dump(mode="json"),
                    )
                )
                if checkpoint is None:
                    checkpoint = LegacyImport(
                        source_id=source_id, contribution_id=c.id, fingerprint=record_hash
                    )
                    session.add(checkpoint)
                checkpoint.fingerprint = record_hash
                checkpoint.revision_id = c.head_revision
                checkpoint.updated_at = now
                enqueue(session, c)
                await Storage.for_node(node).put_json(
                    f"migration/{inventory.source_id}/{record.id}/{record_hash}.json",
                    record.model_dump(mode="json"),
                )
                # Keep generated IDs clear of imported public identifiers.
                await session.execute(
                    text(
                        "SELECT setval(pg_get_serial_sequence(:table, 'id'), "
                        "GREATEST((SELECT COALESCE(MAX(id),1) FROM "
                        f'"{node.node.slug}".contributions), 1))'
                    ),
                    {"table": f'"{node.node.slug}".contributions'},
                )
                await session.commit()
                report["applied"] += 1
        except Exception as exc:
            report["errors"].append({"id": record.id, "error": str(exc)})
    return report
