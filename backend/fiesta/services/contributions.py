"""Contribution workflow: the one place that coordinates Postgres (state),
object storage (durable record) and OpenSearch (projection).

Used by the private API, the procrastinate worker, and the CLI so behavior is
identical however the workflow is driven.
"""

import logging
import re
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from fiesta.db.models import Contribution, ContributionStatus, User, ValidationResult
from fiesta.domain.parse import ParsedContribution, ParseError, parse_text
from fiesta.domain.summarize import summarize
from fiesta.domain.validate import guess_data_model_version, validate_contribution
from fiesta.nodeconfig import NodeConfig
from fiesta.search.client import get_opensearch
from fiesta.search.documents import (
    delete_contribution_docs,
    index_contribution_docs,
    update_contribution_flags,
)
from fiesta.search.index import ensure_index
from fiesta.storage import Storage, contribution_prefix, file_key, manifest_key

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
    storage = Storage.for_node(node)
    await storage.put_bytes(file_key(contribution.id, contribution.filename), data)


async def load_file(node: NodeConfig, contribution_id: int, filename: str) -> bytes:
    storage = Storage.for_node(node)
    return await storage.get_bytes(file_key(contribution_id, filename))


async def process_contribution(
    session: AsyncSession, node: NodeConfig, contribution_id: int
) -> None:
    """Parse + validate + summarize + index a contribution's stored file, then
    persist the outcome. Safe to re-run at any time (idempotent projection)."""
    contribution = await session.get(Contribution, contribution_id)
    if contribution is None or contribution.filename is None:
        logger.warning("contribution %s missing or has no file; skipping", contribution_id)
        return
    if contribution.node != node.node.slug:
        logger.error(
            "contribution %s belongs to node %r, not %r; skipping",
            contribution_id,
            contribution.node,
            node.node.slug,
        )
        return
    contributor = await session.get(User, contribution.contributor_id)

    try:
        contribution.status = ContributionStatus.PARSING
        await session.commit()
        raw = await load_file(node, contribution.id, contribution.filename)
        parsed = parse_text(raw.decode("utf-8", errors="replace"))
        contribution.data_model_version = guess_data_model_version(node, parsed)
        if not contribution.reference_doi:
            rows = parsed.tables.get("contribution", [])
            reference = rows[0].get("reference", "") if rows else ""
            if re.match(r"^10\.\S+/\S+$", reference):
                contribution.reference_doi = reference

        contribution.status = ContributionStatus.VALIDATING
        await session.commit()
        report = validate_contribution(node, parsed, contribution.data_model_version)
        session.add(
            ValidationResult(
                contribution_id=contribution.id,
                is_valid=report.is_valid,
                errors=[e.as_dict() for e in report.errors],
                warnings=[w.as_dict() for w in report.warnings],
            )
        )

        contribution.status = ContributionStatus.SUMMARIZING
        await session.commit()
        await index_parsed(node, contribution, contributor, parsed)

        contribution.status = ContributionStatus.READY
        contribution.error = None
    except ParseError as exc:
        contribution.status = ContributionStatus.FAILED
        contribution.error = str(exc)
        session.add(
            ValidationResult(
                contribution_id=contribution.id,
                is_valid=False,
                errors=[{"table": None, "row": exc.line, "column": None, "message": str(exc)}],
            )
        )
    except Exception as exc:  # pragma: no cover — defensive: mark failed, don't lose the job
        logger.exception("processing contribution %s failed", contribution_id)
        contribution.status = ContributionStatus.FAILED
        contribution.error = str(exc)
    await session.commit()
    await save_manifest(node, contribution, contributor)


async def index_parsed(
    node: NodeConfig, contribution: Contribution, contributor: User, parsed: ParsedContribution
) -> None:
    from fiesta.plugins import active_plugins

    client = get_opensearch()
    await ensure_index(client, node.search_index)
    meta = contribution_meta(contribution, contributor)
    docs = summarize(node, parsed, meta)
    for plugin in active_plugins(node):
        docs.extend(plugin.derive_docs(node, parsed, meta))
    await index_contribution_docs(client, node.search_index, contribution.id, docs)


async def latest_validation(session: AsyncSession, contribution_id: int) -> ValidationResult | None:
    result = await session.execute(
        select(ValidationResult)
        .where(ValidationResult.contribution_id == contribution_id)
        .order_by(ValidationResult.validated_at.desc(), ValidationResult.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def activate(session: AsyncSession, node: NodeConfig, contribution: Contribution) -> None:
    """Publish: mark the previous version superseded, flag this one activated,
    and update projections + manifests."""
    contributor = await session.get(User, contribution.contributor_id)
    client = get_opensearch()

    if contribution.previous_id is not None:
        previous = await session.get(Contribution, contribution.previous_id)
        if previous is not None and previous.is_latest:
            previous.is_latest = False
            await update_contribution_flags(
                client, node.search_index, previous.id, {"_is_latest": False}
            )
            previous_contributor = await session.get(User, previous.contributor_id)
            await save_manifest(node, previous, previous_contributor)

    contribution.is_activated = True
    contribution.activated_at = datetime.now(UTC)
    await session.commit()
    await update_contribution_flags(
        client,
        node.search_index,
        contribution.id,
        {"_is_activated": True, "timestamp": contribution.activated_at.isoformat()},
    )
    await save_manifest(node, contribution, contributor)


async def deactivate(session: AsyncSession, node: NodeConfig, contribution: Contribution) -> None:
    contributor = await session.get(User, contribution.contributor_id)
    contribution.is_activated = False
    await session.commit()
    await update_contribution_flags(
        get_opensearch(), node.search_index, contribution.id, {"_is_activated": False}
    )
    await save_manifest(node, contribution, contributor)


async def delete_contribution(
    session: AsyncSession, node: NodeConfig, contribution: Contribution
) -> None:
    await delete_contribution_docs(get_opensearch(), node.search_index, contribution.id)
    await Storage.for_node(node).delete_prefix(contribution_prefix(contribution.id))
    await session.delete(contribution)
    await session.commit()
