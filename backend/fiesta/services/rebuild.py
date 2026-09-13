"""Rebuild search from authoritative Postgres selections and revision objects.

Does not recreate accounts, restore metadata, or mutate revision history.
"""

import uuid

from sqlalchemy import select, text

from fiesta.db.models import Contribution, User
from fiesta.domain.parse import ParseError, parse_text
from fiesta.search.client import get_opensearch
from fiesta.search.index import ensure_index
from fiesta.services.contributions import index_parsed, load_file
from fiesta.services.revisions import revision_file
from fiesta.settings import get_settings


async def rebuild_node(session, node):
    client = get_opensearch()
    alias = node.search_index
    target = f"{alias}-build-{uuid.uuid4().hex}"
    # SHARE blocks concurrent contribution writes for a consistent alias switch.
    # This is an explicit maintenance operation, not the normal event path.
    await session.execute(text(f'LOCK TABLE "{node.node.slug}".contributions IN SHARE MODE'))
    await ensure_index(client, target)
    indexed = 0
    try:
        rows = (
            await session.execute(select(Contribution).where(Contribution.deleted_at.is_(None)))
        ).scalars()
        target_node = node.model_copy(
            update={
                "search": node.search.model_copy(
                    update={
                        "index": target.removeprefix(
                            get_settings().index_prefix
                        )
                    }
                )
            }
        )
        for c in rows:
            if not c.filename:
                continue
            raw = (
                await revision_file(session, node, c)
                if c.head_revision
                else await load_file(node, c.id, c.filename)
            )
            contributor = await session.get(User, c.contributor_id)
            try:
                parsed = parse_text(raw.decode("utf-8"))
            except (ParseError, UnicodeDecodeError):
                continue
            await index_parsed(target_node, c, contributor, parsed)
            indexed += 1
        actions = []
        if await client.indices.exists_alias(name=alias):
            old = await client.indices.get_alias(name=alias)
            actions += [{"remove": {"index": index, "alias": alias}} for index in old]
        elif await client.indices.exists(index=alias):
            # Legacy installs used a concrete index under the alias name.
            actions.append({"remove_index": {"index": alias}})
        actions.append({"add": {"index": target, "alias": alias}})
        await client.indices.update_aliases(body={"actions": actions})
        await session.commit()
    except Exception:
        await session.rollback()
        await client.indices.delete(index=target)
        raise
    return {"indexed": indexed, "index": target, "alias": alias}
