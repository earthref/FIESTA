"""Rebuild Postgres + OpenSearch from the deployment YAML and the bucket.

The bucket holds, per contribution, the canonical file and a manifest.json
with the workflow metadata — together with the node YAML that is the entire
durable state of a FIESTA node. This module re-creates:

- users (placeholder accounts from manifest contributor blocks; passwords are
  NOT stored in manifests, so rebuilt accounts need a password reset),
- the contributions table,
- the search index (re-parse + re-summarize + re-index every contribution).
"""

import logging
import uuid
from datetime import datetime

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from fiesta.db.models import Contribution, ContributionStatus, User
from fiesta.domain.parse import parse_text
from fiesta.nodeconfig import NodeConfig
from fiesta.search.client import get_opensearch
from fiesta.search.index import recreate_index
from fiesta.services.contributions import index_parsed
from fiesta.storage import Storage, file_key

logger = logging.getLogger(__name__)


def _parse_dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


async def _get_or_create_user(session: AsyncSession, info: dict) -> User:
    email = info.get("email") or f"unknown+{info.get('id', 0)}@earthref.org"
    existing = (
        await session.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if existing:
        return existing
    user = User(email=email, name=info.get("name") or email, orcid=info.get("orcid"))
    session.add(user)
    await session.flush()
    return user


async def rebuild_node(session: AsyncSession, node: NodeConfig) -> dict:
    """Full rebuild. Wipes the node's search index and repopulates both stores
    from the bucket. Returns counts for reporting."""
    storage = Storage.for_node(node)
    await storage.ensure_bucket()
    client = get_opensearch()
    await recreate_index(client, node.search_index)

    manifest_keys = [
        k for k in await storage.list_keys("contributions/") if k.endswith("/manifest.json")
    ]
    logger.info("rebuilding %s: %d manifests found", node.node.key, len(manifest_keys))

    restored = indexed = failed = 0
    # `previous_id` is a self-referencing FK; manifests can reference version
    # ids in any order, so set it in a second pass once every row exists.
    previous_ids: dict[int, int] = {}
    for key in sorted(manifest_keys, key=lambda k: int(k.split("/")[1])):
        manifest = await storage.get_json(key)
        contribution_id = manifest["id"]
        contributor = await _get_or_create_user(session, manifest.get("contributor", {}))

        contribution = await session.get(Contribution, contribution_id)
        if contribution is None:
            contribution = Contribution(
                id=contribution_id,
                node=node.node.slug,
                contributor_id=contributor.id,
                data_model_version=manifest.get("data_model_version", node.data_model.latest),
            )
            session.add(contribution)
        contribution.node = manifest.get("node", node.node.slug)
        contribution.version = manifest.get("version", 1)
        contribution.previous_id = None  # set in the second pass
        if manifest.get("previous_id") is not None:
            previous_ids[contribution_id] = manifest["previous_id"]
        contribution.contributor_id = contributor.id
        contribution.private_key = uuid.UUID(manifest["private_key"])
        contribution.is_activated = manifest.get("is_activated", False)
        contribution.is_latest = manifest.get("is_latest", True)
        contribution.reference_doi = manifest.get("reference_doi")
        contribution.filename = manifest.get("filename")
        contribution.status = ContributionStatus(manifest.get("status", "ready"))
        contribution.created_at = _parse_dt(manifest.get("created_at")) or contribution.created_at
        contribution.activated_at = _parse_dt(manifest.get("activated_at"))
        await session.flush()
        restored += 1

        if contribution.filename:
            try:
                raw = await storage.get_bytes(file_key(contribution_id, contribution.filename))
                parsed = parse_text(raw.decode("utf-8", errors="replace"))
                await index_parsed(node, contribution, contributor, parsed)
                indexed += 1
            except Exception:
                logger.exception("failed to re-index contribution %s", contribution_id)
                failed += 1

    # Second pass: wire up previous_id now that all rows exist.
    for contribution_id, previous_id in previous_ids.items():
        if await session.get(Contribution, previous_id) is not None:
            (await session.get(Contribution, contribution_id)).previous_id = previous_id
    await session.commit()
    # Keep the contributions id sequence ahead of restored ids.
    max_id = (await session.execute(select(func.max(Contribution.id)))).scalar() or 0
    await session.execute(
        text("SELECT setval(pg_get_serial_sequence('contributions', 'id'), :v)"),
        {"v": max(max_id, 1)},
    )
    await session.commit()
    return {
        "manifests": len(manifest_keys),
        "restored": restored,
        "indexed": indexed,
        "failed": failed,
    }
