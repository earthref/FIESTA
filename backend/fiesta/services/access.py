"""Postgres permission checks shared by API and search projections."""

from fastapi import HTTPException
from sqlalchemy import select

from fiesta.db.models import Contribution, Workspace, WorkspaceMember


async def can_access(session, contribution, user, write=False):
    if user.is_admin or contribution.contributor_id == user.id:
        return True
    if not contribution.workspace_id:
        return False
    workspace = await session.get(Workspace, contribution.workspace_id)
    if workspace.owner_id == user.id:
        return True
    member = await session.get(WorkspaceMember, (workspace.id, user.id))
    return member is not None and (not write or member.role == "editor")


async def visible_ids(session, node, user=None, private_keys=()):
    rows = (
        await session.execute(
            select(Contribution).where(
                Contribution.node == node.node.slug, Contribution.deleted_at.is_(None)
            )
        )
    ).scalars()
    if user is None:
        return [
            c.id for c in rows if c.is_latest and (c.is_activated or c.private_key in private_keys)
        ]
    return [c.id for c in rows if await can_access(session, c, user)]


async def constrain_search(session, node, body, user=None, query=None):
    # Filter before aggregations and pagination, not just after retrieving hits.
    import uuid
    from contextlib import suppress

    from fiesta.search.queries import parse_query

    _, tokens = parse_query(query)
    keys = []
    for value in tokens.get("private_key", []):
        with suppress(ValueError):
            keys.append(uuid.UUID(value))
    ids = await visible_ids(session, node, user, keys)
    groups = [
        {"terms": {"summary.contribution.id": ids[i : i + 60000]}}
        for i in range(0, len(ids), 60000)
    ]
    body["query"]["bool"]["filter"].append(
        {"bool": {"should": groups, "minimum_should_match": 1}} if groups else {"match_none": {}}
    )


async def workspace_owner(session, workspace_id, user):
    workspace = await session.get(Workspace, workspace_id)
    if workspace is None or (workspace.owner_id != user.id and not user.is_admin):
        raise HTTPException(404, "workspace not found")
    return workspace
