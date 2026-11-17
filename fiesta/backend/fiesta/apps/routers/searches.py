"""Saved searches (fiesta.services.searches): the search page posts its state
and gets the id its URL carries (`?q=<id>`); a link loads the state by id.
Anyone may save or open one, signed in or not (a shared link must work for
everyone). Node admins see what the node's searches are used for."""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, true
from sqlalchemy.dialects.postgresql import insert

from fiesta.apps.deps import CurrentUser, NodeDep, OptionalUser, SessionDep
from fiesta.db.models import SavedSearch, SearchUse
from fiesta.services.searches import SearchState, StateTooLarge, canonical, check_size, search_id

router = APIRouter(prefix="/searches", tags=["searches"])

PathName = Field(None, max_length=64)


class SaveIn(BaseModel):
    state: SearchState
    # Where the search page is (URL path), for the usage counts only.
    level: str | None = PathName
    view: str | None = PathName


class SearchOut(BaseModel):
    id: uuid.UUID
    state: dict
    created_at: datetime


@router.post("")
async def save_search(
    body: SaveIn, node: NodeDep, session: SessionDep, user: OptionalUser
) -> SearchOut:
    try:
        check_size(body.state)
    except StateTooLarge as exc:
        raise HTTPException(413, str(exc)) from exc
    sid = search_id(node.node.slug, body.state)
    now = datetime.now(UTC)
    state = canonical(body.state)
    row = (
        await session.execute(
            insert(SavedSearch)
            .values(
                id=sid,
                state=state,
                created_by=user.id if user else None,
                created_at=now,
                last_used_at=now,
                use_count=1,
            )
            .on_conflict_do_update(
                index_elements=[SavedSearch.id],
                set_={"last_used_at": now, "use_count": SavedSearch.use_count + 1},
            )
            .returning(SavedSearch.created_at)
        )
    ).one()
    session.add(
        SearchUse(
            search_id=sid,
            user_id=user.id if user else None,
            kind="save",
            level=body.level,
            view=body.view,
            used_at=now,
        )
    )
    await session.commit()
    return SearchOut(id=sid, state=state, created_at=row.created_at)


class UsageLevel(BaseModel):
    level: str | None
    view: str | None
    uses: int


class UsageKey(BaseModel):
    key: str
    uses: int


class UsageSearch(BaseModel):
    id: uuid.UUID
    state: dict
    uses: int
    users: int
    last_used_at: datetime


class UsageOut(BaseModel):
    days: int
    uses: int
    searches: int
    users: int
    levels: list[UsageLevel]
    # State fields and plugin settings the uses' searches set ("query",
    # "ranges", "settings.map.color").
    keys: list[UsageKey]
    top: list[UsageSearch]


@router.get("/usage")
async def search_usage(
    node: NodeDep,
    session: SessionDep,
    user: CurrentUser,
    days: int = Query(30, ge=1, le=3650),
    limit: int = Query(50, ge=1, le=500),
) -> UsageOut:
    """What the node's searches were used for over the last `days` (node admins)."""
    if not user.is_node_admin(node.node.slug):
        raise HTTPException(403, "node admins only")
    since = datetime.now(UTC) - timedelta(days=days)
    recent = SearchUse.used_at >= since

    totals = (
        await session.execute(
            select(
                func.count(SearchUse.id),
                func.count(func.distinct(SearchUse.search_id)),
                func.count(func.distinct(SearchUse.user_id)),
            ).where(recent)
        )
    ).one()

    levels = (
        await session.execute(
            select(SearchUse.level, SearchUse.view, func.count(SearchUse.id).label("uses"))
            .where(recent)
            .group_by(SearchUse.level, SearchUse.view)
            .order_by(func.count(SearchUse.id).desc())
            .limit(limit)
        )
    ).all()

    keys: dict[str, int] = {}
    # jsonb_object_keys(...) AS field(key): each saved search's state keys,
    # and its settings' keys.
    field = func.jsonb_object_keys(SavedSearch.state).table_valued("key").render_derived("field")
    setting = (
        func.jsonb_object_keys(SavedSearch.state["settings"])
        .table_valued("key")
        .render_derived("setting")
    )
    for source, prefix in ((field, ""), (setting, "settings.")):
        rows = (
            await session.execute(
                select(source.c.key, func.count(SearchUse.id))
                .select_from(SearchUse)
                .join(SavedSearch, SavedSearch.id == SearchUse.search_id)
                .join(source, true())
                .where(recent)
                .group_by(source.c.key)
            )
        ).all()
        for key, uses in rows:
            if prefix or key != "settings":
                keys[f"{prefix}{key}"] = uses

    top = (
        await session.execute(
            select(
                SavedSearch.id,
                SavedSearch.state,
                func.count(SearchUse.id).label("uses"),
                func.count(func.distinct(SearchUse.user_id)).label("users"),
                func.max(SearchUse.used_at).label("last_used_at"),
            )
            .join(SearchUse, SearchUse.search_id == SavedSearch.id)
            .where(recent)
            .group_by(SavedSearch.id, SavedSearch.state)
            .order_by(func.count(SearchUse.id).desc())
            .limit(limit)
        )
    ).all()

    return UsageOut(
        days=days,
        uses=totals[0],
        searches=totals[1],
        users=totals[2],
        levels=[UsageLevel(level=r.level, view=r.view, uses=r.uses) for r in levels],
        keys=[
            UsageKey(key=k, uses=n) for k, n in sorted(keys.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        top=[
            UsageSearch(
                id=r.id, state=r.state, uses=r.uses, users=r.users, last_used_at=r.last_used_at
            )
            for r in top
        ],
    )


@router.get("/{sid}")
async def open_search(
    sid: uuid.UUID,
    session: SessionDep,
    user: OptionalUser,
    level: str | None = Query(None, max_length=64),
    view: str | None = Query(None, max_length=64),
) -> SearchOut:
    row = await session.get(SavedSearch, sid)
    if row is None:
        raise HTTPException(404, "no such search")
    now = datetime.now(UTC)
    row.last_used_at = now
    row.use_count += 1
    session.add(
        SearchUse(
            search_id=sid,
            user_id=user.id if user else None,
            kind="open",
            level=level,
            view=view,
            used_at=now,
        )
    )
    await session.commit()
    return SearchOut(id=row.id, state=row.state, created_at=row.created_at)
