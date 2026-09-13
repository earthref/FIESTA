"""Contribution workflow: the one place that coordinates Postgres (state),
object storage (durable record) and OpenSearch (projection).

Used by the private API, the procrastinate worker, and the CLI so behavior is
identical however the workflow is driven.
"""

import gzip
import json
import logging
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from fiesta.db.models import Contribution, ContributionStatus, User, ValidationResult
from fiesta.domain.parse import ParseError, parse_text
from fiesta.domain.summarize import summarize
from fiesta.domain.validate import guess_data_model_version, validate_contribution
from fiesta.nodeconfig import NodeConfig
from fiesta.search.client import get_opensearch
from fiesta.search.documents import (
    index_contribution_docs,
)
from fiesta.search.index import ensure_index
from fiesta.storage import Storage, file_key, manifest_key

logger = logging.getLogger(__name__)


def default_filename(node: NodeConfig, contribution_id: int) -> str:
    return f"{node.node.slug}_contribution_{contribution_id}.txt"


def manifest_for(contribution: Contribution, contributor: User) -> dict:
    return {
        "id": contribution.id,
        "node": contribution.node,
        "version": contribution.version,
        "previous_id": contribution.previous_id,
        "contributor": {
            "id": contributor.id,
            "email": contributor.email,
            "name": contributor.name,
            "orcid": contributor.orcid,
        },
        "private_key": str(contribution.private_key),
        "is_activated": contribution.is_activated,
        "is_latest": contribution.is_latest,
        "data_model_version": contribution.data_model_version,
        "reference_doi": contribution.reference_doi,
        "filename": contribution.filename,
        "status": contribution.status.value,
        "created_at": contribution.created_at,
        "updated_at": contribution.updated_at,
        "activated_at": contribution.activated_at,
    }


def contribution_meta(contribution: Contribution, contributor: User) -> dict:
    """Workflow fields merged into summary.contribution on every search doc."""
    return {
        "id": contribution.id,
        "version": contribution.version,
        "timestamp": (contribution.activated_at or contribution.updated_at).isoformat(),
        "data_model_version": contribution.data_model_version,
        "_contributor": contributor.name,
        "_contributor_id": contributor.id,
        "_private_key": str(contribution.private_key),
        "_is_activated": contribution.is_activated,
        "_is_latest": contribution.is_latest,
        "_reference": {"doi": contribution.reference_doi} if contribution.reference_doi else {},
        "_history": {"previous_id": contribution.previous_id},
    }


async def save_manifest(node: NodeConfig, contribution: Contribution, contributor: User) -> None:
    storage = Storage.for_node(node)
    await storage.put_json(manifest_key(contribution.id), manifest_for(contribution, contributor))


async def store_file(node: NodeConfig, contribution: Contribution, data: bytes) -> None:
    raise RuntimeError("Use save_revision in the contribution transaction")


async def load_file(node: NodeConfig, contribution_id: int, filename: str) -> bytes:
    from fiesta.db.session import get_sessionmaker
    from fiesta.services.revisions import revision_file

    async with get_sessionmaker(node.node.slug)() as session:
        contribution = await session.get(Contribution, contribution_id)
        if contribution.head_revision:
            return await revision_file(session, node, contribution)
    return await Storage.for_node(node).get_bytes(file_key(contribution_id, filename))


@lru_cache
def pipeline_hash():
    from fiesta.services.revisions import digest, fingerprint

    root = Path(__file__).resolve().parents[1]
    return fingerprint(
        {str(p.relative_to(root)): digest(p.read_bytes()) for p in sorted(root.rglob("*.py"))}
    )


async def derive_artifacts(session, node, contribution):
    """Validation survives search failure and is tied to an immutable revision."""
    import uuid

    from fiesta.db.models import Revision
    from fiesta.plugins import active_plugins
    from fiesta.services.revisions import fingerprint, revision_file

    revision = await session.get(Revision, contribution.head_revision)
    raw = await revision_file(session, node, contribution)
    run_id = str(uuid.uuid4())
    prefix = f"contributions/{contribution.id}/revisions/{revision.id}/artifacts/{run_id}"
    inputs = {
        "data_models": {v: node.load_data_model(v) for v in node.data_model.versions},
        "controlled_vocabularies": node.load_controlled_vocabularies(),
        "suggested_vocabularies": node.load_suggested_vocabularies(),
        "config": node.model_dump(mode="json"),
    }
    inputs_key = f"processing-inputs/{fingerprint(inputs)}.json"
    storage = Storage.for_node(node)
    if not await storage.exists(inputs_key):
        await storage.put_json(inputs_key, inputs)
    provenance = {
        "inputs_key": inputs_key,
        "revision_id": revision.id,
        "snapshot_hash": fingerprint(revision.snapshot),
        "config_hash": fingerprint(node.model_dump(mode="json")),
        "model_hash": fingerprint(node.load_data_model(contribution.data_model_version)),
        "vocabulary_hash": fingerprint(node.load_controlled_vocabularies()),
        "pipeline_version": pipeline_hash(),
        "artifact_schema": 1,
        "plugins": node.features.plugins,
        "created_at": datetime.now(UTC).isoformat(),
    }
    docs = []
    try:
        parsed = parse_text(raw.decode("utf-8"))
        version = guess_data_model_version(node, parsed)
        provenance["data_model_version"] = version
        provenance["model_hash"] = fingerprint(node.load_data_model(version))
        report = validate_contribution(node, parsed, version)
        errors = [e.as_dict() for e in report.errors]
        warnings = [w.as_dict() for w in report.warnings]
        contributor = await session.get(User, contribution.contributor_id)
        docs = summarize(node, parsed, contribution_meta(contribution, contributor))
        for plugin in active_plugins(node):
            docs.extend(
                plugin.derive_docs(node, parsed, contribution_meta(contribution, contributor))
            )
        contribution.data_model_version = version
        contribution.status = ContributionStatus.READY
        contribution.error = None
    except (ParseError, UnicodeDecodeError) as exc:
        errors = [{"table": None, "row": None, "column": None, "message": str(exc)}]
        warnings = []
        contribution.status = ContributionStatus.FAILED
        contribution.error = str(exc)
    storage = Storage.for_node(node)
    validation_key = f"{prefix}/validation.json"
    await storage.put_json(
        validation_key,
        {"provenance": provenance, "is_valid": not errors, "errors": errors, "warnings": warnings},
    )
    await storage.put_bytes(
        f"{prefix}/summary.json.gz",
        gzip.compress(
            json.dumps({"provenance": provenance, "documents": docs}, default=str).encode()
        ),
        content_type="application/gzip",
    )
    session.add(
        ValidationResult(
            contribution_id=contribution.id,
            revision_id=revision.id,
            artifact_key=validation_key,
            is_valid=not errors,
            errors=errors,
            warnings=warnings,
        )
    )
    return docs


async def process_contribution(session: AsyncSession, node: NodeConfig, contribution_id: int):
    from fiesta.services.revisions import enqueue, locked

    contribution = await locked(session, contribution_id)
    enqueue(session, contribution)
    await session.commit()


async def index_parsed(node, contribution, contributor, parsed):
    from fiesta.plugins import active_plugins

    docs = summarize(node, parsed, contribution_meta(contribution, contributor))
    for plugin in active_plugins(node):
        docs.extend(plugin.derive_docs(node, parsed, contribution_meta(contribution, contributor)))
    await ensure_index(get_opensearch(), node.search_index)
    await index_contribution_docs(get_opensearch(), node.search_index, contribution.id, docs)


async def latest_validation(session: AsyncSession, contribution_id: int) -> ValidationResult | None:
    result = await session.execute(
        select(ValidationResult)
        .where(
            ValidationResult.contribution_id == contribution_id,
            ValidationResult.revision_id
            == select(Contribution.head_revision)
            .where(Contribution.id == contribution_id)
            .scalar_subquery(),
        )
        .order_by(ValidationResult.validated_at.desc(), ValidationResult.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def activate(
    session: AsyncSession, node: NodeConfig, contribution: Contribution, *, actor_id=None
) -> None:
    from fastapi import HTTPException

    from fiesta.db.models import AuditEvent
    from fiesta.services.revisions import enqueue, locked

    contribution = await locked(session, contribution.id)
    report = await latest_validation(session, contribution.id)
    if (
        contribution.deleted_at
        or not contribution.head_revision
        or not report
        or not report.is_valid
    ):
        raise HTTPException(409, "current revision must pass validation before publishing")
    if contribution.previous_id:
        previous = await locked(session, contribution.previous_id)
        previous.is_latest = False
        enqueue(session, previous, "index")
    contribution.is_activated = True
    contribution.published_revision = contribution.head_revision
    contribution.activated_at = datetime.now(UTC)
    session.add(
        AuditEvent(
            contribution_id=contribution.id,
            actor_id=actor_id or contribution.contributor_id,
            operation="publish",
            details={"revision": contribution.head_revision},
        )
    )
    enqueue(session, contribution, "index")
    await session.commit()


async def deactivate(
    session: AsyncSession, node: NodeConfig, contribution: Contribution, *, actor_id=None
) -> None:
    from fiesta.db.models import AuditEvent
    from fiesta.services.revisions import enqueue, locked

    contribution = await locked(session, contribution.id)
    contribution.is_activated = False
    session.add(
        AuditEvent(
            contribution_id=contribution.id,
            actor_id=actor_id or contribution.contributor_id,
            operation="withdraw",
            details={},
        )
    )
    enqueue(session, contribution, "index")
    await session.commit()


async def delete_contribution(
    session: AsyncSession, node: NodeConfig, contribution: Contribution, *, actor_id=None
):
    from fastapi import HTTPException

    from fiesta.db.models import AuditEvent
    from fiesta.services.revisions import enqueue, locked

    contribution = await locked(session, contribution.id)
    if contribution.is_activated:
        raise HTTPException(409, "withdraw a published contribution before deleting")
    contribution.deleted_at = datetime.now(UTC)
    session.add(
        AuditEvent(
            contribution_id=contribution.id,
            actor_id=actor_id or contribution.contributor_id,
            operation="delete",
            details={},
        )
    )
    enqueue(session, contribution, "index")
    await session.commit()
