"""Postgres permission checks shared by API and search projections."""

from fastapi import HTTPException
from sqlalchemy import select

from fiesta.db.models import Contribution, Workspace, WorkspaceMember


async def can_access(session, contribution, user, write=False):
    if user.is_node_admin(contribution.node) or contribution.contributor_id == user.id:
        return True
    if not contribution.workspace_id:
        return False
    workspace = await session.get(Workspace, contribution.workspace_id)
    if workspace.owner_id == user.id:
        return True
    member = await session.get(WorkspaceMember, (workspace.id, user.id))
    return member is not None and (not write or member.role == "editor")


async def visible_ids(session, node, user=None, private_keys=(), latest_only=True):
    """Ids of the node's contributions a search may return: the published
    ones, those opened by one of `private_keys` and, for `user`, the ones they
    may access (their own, a shared workspace's, every one for a node admin).
    `latest_only` keeps each contribution's latest version alone."""
    rows = (
        await session.execute(
            select(Contribution).where(
                Contribution.node == node.node.slug, Contribution.deleted_at.is_(None)
            )
        )
    ).scalars()
    ids = []
    for c in rows:
        if latest_only and not c.is_latest:
            continue
        if (
            c.is_activated
            or c.private_key in private_keys
            or (user is not None and await can_access(session, c, user))
        ):
            ids.append(c.id)
    return ids


# `mine`: only the signed-in user's own contributions, in preparation
# (unpublished) or published.
MINE_IN_PREP = "in_prep"
MINE_PUBLISHED = "published"

_ACTIVATED = "summary.contribution._is_activated"
_LATEST = "summary.contribution._is_latest"


def _without(filters: list[dict], field: str) -> list[dict]:
    return [f for f in filters if field not in str(f)]


async def constrain_search(
    session, node, body, user=None, query=None, mine=None, all_versions=False
):
    """Scope a search body (from build_search_body) to what the caller may
    see: the one place a search's visibility is decided.

    By default, the latest version of published contributions plus any opened
    by a `private_key:` token. `all_versions` drops the latest-only rule (older
    versions, still subject to the rest). `mine` narrows the search to `user`'s
    own contributions: "published", or "in_prep", the one path to unpublished
    docs without a private key. `user` is the session's, never a client's id;
    without one `mine` is refused."""
    # Filter before aggregations and pagination, not just after retrieving hits.
    import uuid
    from contextlib import suppress

    from fiesta.search.queries import parse_query

    if mine not in (None, MINE_IN_PREP, MINE_PUBLISHED):
        raise HTTPException(422, f"mine must be {MINE_IN_PREP} or {MINE_PUBLISHED}")
    if mine and user is None:
        raise HTTPException(401, "log in to search your own contributions")
    filters = body["query"]["bool"]["filter"]
    if all_versions:
        filters[:] = _without(filters, _LATEST)
    if mine:
        filters[:] = _without(filters, _ACTIVATED)
        filters.append({"term": {_ACTIVATED: mine == MINE_PUBLISHED}})
        filters.append({"term": {"summary.contribution._contributor_id": user.id}})

    _, tokens = parse_query(query)
    keys = []
    for value in tokens.get("private_key", []):
        with suppress(ValueError):
            keys.append(uuid.UUID(value))
    ids = await visible_ids(
        session,
        node,
        user if mine == MINE_IN_PREP else None,
        keys,
        latest_only=not all_versions,
    )
    groups = [
        {"terms": {"summary.contribution.id": ids[i : i + 60000]}}
        for i in range(0, len(ids), 60000)
    ]
    filters.append(
        {"bool": {"should": groups, "minimum_should_match": 1}} if groups else {"match_none": {}}
    )


async def workspace_owner(session, workspace_id, user, node_slug):
    workspace = await session.get(Workspace, workspace_id)
    if workspace is None or (workspace.owner_id != user.id and not user.is_node_admin(node_slug)):
        raise HTTPException(404, "workspace not found")
    return workspace
