"""Poll committed Postgres events; retries never depend on an external queue write."""

import asyncio
import logging
from datetime import UTC, datetime

from sqlalchemy import select

from fiesta.db.models import Outbox, User
from fiesta.db.session import get_sessionmaker
from fiesta.domain.parse import ParseError, parse_text
from fiesta.search.client import get_opensearch
from fiesta.search.documents import delete_contribution_docs
from fiesta.search.index import ensure_index
from fiesta.services.contributions import derive_artifacts, index_parsed, latest_validation
from fiesta.services.revisions import locked, revision_file

logger = logging.getLogger(__name__)


async def drain(node, limit=100):
    completed = failed = 0
    seen = []
    for _ in range(limit):
        async with get_sessionmaker(node.node.slug)() as session:
            event = (
                await session.execute(
                    select(Outbox)
                    .where(Outbox.completed_at.is_(None), Outbox.id.not_in(seen))
                    .order_by(Outbox.id)
                    .with_for_update(skip_locked=True)
                    .limit(1)
                )
            ).scalar_one_or_none()
            if event is None:
                break
            seen.append(event.id)
            contribution = await locked(session, event.contribution_id)
            if event.revision_id != contribution.head_revision:
                event.completed_at = datetime.now(UTC)
                await session.commit()
                continue
            event.attempts += 1
            try:
                async with session.begin_nested():
                    if contribution.head_revision and not contribution.deleted_at:
                        report = await latest_validation(session, contribution.id)
                        if report is None or event.kind == "process":
                            await derive_artifacts(session, node, contribution)
                            await session.flush()
            except Exception as exc:
                event.error = str(exc)
                contribution.indexing_status = "failed"
                failed += 1
                await session.commit()
                continue
            try:
                await ensure_index(get_opensearch(), node.search_index)
                if contribution.deleted_at or not contribution.head_revision:
                    await delete_contribution_docs(
                        get_opensearch(), node.search_index, contribution.id
                    )
                else:
                    raw = await revision_file(session, node, contribution)
                    try:
                        parsed = parse_text(raw.decode("utf-8"))
                    except (ParseError, UnicodeDecodeError):
                        await delete_contribution_docs(
                            get_opensearch(), node.search_index, contribution.id
                        )
                    else:
                        user = await session.get(User, contribution.contributor_id)
                        await index_parsed(node, contribution, user, parsed)
                contribution.indexing_status = "indexed"
                event.error = None
                event.completed_at = datetime.now(UTC)
                completed += 1
            except Exception as exc:
                event.error = str(exc)
                event.kind = "index"  # validation is already durable; only retry search
                contribution.indexing_status = "failed"
                failed += 1
                logger.warning("index event %s will retry: %s", event.id, exc)
            await session.commit()
    return {"completed": completed, "failed": failed}


async def serve(nodes):
    while True:
        for node in nodes:
            try:
                await drain(node)
            except Exception as exc:
                logger.warning("outbox poll failed for %s: %s", node.node.slug, exc)
        await asyncio.sleep(2)
