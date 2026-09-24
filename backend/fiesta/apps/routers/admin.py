"""Admin settings: accounts, nodes, node configuration drafts, node admins.

Super admins (`users.is_admin`) do everything on every node: accounts, node
creation, super admin grants, and the protected node settings (key, slug,
search index, storage, legacy source). A node admin (`node_admins`) edits and
publishes that node's configuration and grants or revokes its admins, and can
look up accounts to do so. See fiesta.services.node_config for drafts and
publication.
"""

import base64
from datetime import datetime
from typing import Annotated, Any, Literal

import yaml
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select

from fiesta.apps.deps import CurrentUser, SessionDep
from fiesta.db.models import NodeAdmin, NodeRecord, NodeRevision, User
from fiesta.nodeconfig import get_deployment
from fiesta.plugins import all_plugins
from fiesta.security import hash_password
from fiesta.services import node_config as svc
from fiesta.settings import get_settings

router = APIRouter(tags=["admin"])


# --- permissions --------------------------------------------------------------


def require_any_admin(user: CurrentUser) -> User:
    if not (user.is_admin or user.admin_nodes):
        raise HTTPException(403, "admins only")
    return user


def require_super_admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise HTTPException(403, "super admins only")
    return user


AnyAdmin = Annotated[User, Depends(require_any_admin)]
SuperAdmin = Annotated[User, Depends(require_super_admin)]


def require_editing() -> None:
    if not svc.enabled():
        raise HTTPException(
            409,
            "node configuration is read from files on this deployment "
            "(FIESTA_NODE_CONFIG_SOURCE=files); edit config/ instead",
        )


async def node_for_admin(slug: str, session: SessionDep, user: CurrentUser) -> NodeRecord:
    """The node record, if the caller administers it (404 for anyone else,
    so node slugs do not leak)."""
    require_editing()
    if not user.is_node_admin(slug):
        raise HTTPException(404, f"node {slug!r} not found")
    try:
        return await svc.get_record(session, slug)
    except KeyError:
        raise HTTPException(404, f"node {slug!r} not found") from None


AdminNode = Annotated[NodeRecord, Depends(node_for_admin)]


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, svc.ConfigError):
        return HTTPException(422, {"errors": exc.errors})
    if isinstance(exc, svc.Conflict):
        return HTTPException(409, str(exc))
    if isinstance(exc, PermissionError):
        return HTTPException(403, str(exc))
    if isinstance(exc, KeyError):
        return HTTPException(404, f"{exc.args[0]} not found")
    raise exc


# --- accounts -----------------------------------------------------------------


class AdminUserOut(BaseModel):
    id: int
    email: str
    name: str
    handle: str | None
    orcid: str | None
    is_admin: bool
    admin_nodes: list[str]
    created_at: datetime

    @classmethod
    def from_db(cls, user: User) -> "AdminUserOut":
        return cls(
            id=user.id,
            email=user.email,
            name=user.name,
            handle=user.handle,
            orcid=user.orcid,
            is_admin=user.is_admin,
            admin_nodes=user.admin_nodes,
            created_at=user.created_at,
        )


class UserCreateIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=255)
    handle: str | None = None
    orcid: str | None = None
    password: str | None = Field(default=None, min_length=8)
    is_admin: bool = False


class UserPatchIn(BaseModel):
    email: EmailStr | None = None
    name: str | None = Field(default=None, min_length=1, max_length=255)
    handle: str | None = None
    orcid: str | None = None
    password: str | None = Field(default=None, min_length=8)
    is_admin: bool | None = None
    # Replaces the user's node admin roles (slugs).
    admin_nodes: list[str] | None = None


@router.get("/users")
async def list_users(
    session: SessionDep,
    user: AnyAdmin,
    q: str = "",
    role: Literal["", "super", "node"] = "",
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> dict:
    stmt = select(User)
    if q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(User.email).like(like),
                func.lower(User.name).like(like),
                func.lower(User.handle).like(like),
                User.orcid.like(like),
            )
        )
    if role == "super":
        stmt = stmt.where(User.is_admin.is_(True))
    elif role == "node":
        stmt = stmt.where(User.id.in_(select(NodeAdmin.user_id)))
    total = await session.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (
        await session.execute(stmt.order_by(User.name, User.id).offset(offset).limit(limit))
    ).scalars()
    return {"total": total, "users": [AdminUserOut.from_db(u) for u in rows]}


async def _unique_user_fields(session, email=None, handle=None, orcid=None, exclude=None):
    checks = {
        "email": (func.lower(User.email) == email.lower()) if email else None,
        "handle": (User.handle == handle) if handle else None,
        "orcid": (User.orcid == orcid) if orcid else None,
    }
    for field, clause in checks.items():
        if clause is None:
            continue
        stmt = select(User.id).where(clause)
        if exclude is not None:
            stmt = stmt.where(User.id != exclude)
        if await session.scalar(stmt):
            raise HTTPException(409, f"another account already has that {field}")


async def _set_roles(session, target: User, slugs: list[str], actor: User) -> None:
    known = set((await session.execute(select(NodeRecord.slug))).scalars()) | {
        n.node.slug for n in get_deployment().node_list
    }
    if unknown := sorted(set(slugs) - known):
        raise HTTPException(422, f"unknown nodes {unknown}")
    wanted = set(slugs)
    target.node_roles = [r for r in target.node_roles if r.node in wanted] + [
        NodeAdmin(node=slug, granted_by=actor.id)
        for slug in sorted(wanted - {r.node for r in target.node_roles})
    ]


@router.post("/users", status_code=201)
async def create_user(payload: UserCreateIn, session: SessionDep, actor: SuperAdmin):
    email = payload.email.strip().lower()
    await _unique_user_fields(session, email, payload.handle, payload.orcid)
    user = User(
        email=email,
        name=payload.name,
        handle=payload.handle or None,
        orcid=payload.orcid or None,
        password_hash=hash_password(payload.password) if payload.password else None,
        is_admin=payload.is_admin,
        node_roles=[],
    )
    session.add(user)
    await session.commit()
    return AdminUserOut.from_db(user)


@router.patch("/users/{user_id}")
async def patch_user(user_id: int, payload: UserPatchIn, session: SessionDep, actor: SuperAdmin):
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    fields = payload.model_dump(exclude_unset=True)
    await _unique_user_fields(
        session, fields.get("email"), fields.get("handle"), fields.get("orcid"), exclude=user.id
    )
    if fields.get("is_admin") is False and user.is_admin:
        others = await session.scalar(
            select(func.count()).select_from(User).where(User.is_admin, User.id != user.id)
        )
        if not others:
            raise HTTPException(409, "the last super admin cannot be demoted")
    for field in ("name", "is_admin"):
        if fields.get(field) is not None:
            setattr(user, field, fields[field])
    if "email" in fields and fields["email"]:
        user.email = fields["email"].strip().lower()
    for field in ("handle", "orcid"):
        if field in fields:
            setattr(user, field, fields[field] or None)
    if fields.get("password"):
        user.password_hash = hash_password(fields["password"])
    if payload.admin_nodes is not None:
        await _set_roles(session, user, payload.admin_nodes, actor)
    await session.commit()
    return AdminUserOut.from_db(user)


# --- nodes --------------------------------------------------------------------


def _revision_out(revision: NodeRevision | None, users: dict[int, User]) -> dict | None:
    if revision is None:
        return None

    def name(user_id):
        return users[user_id].name if user_id in users else None

    return {
        "id": revision.id,
        "number": revision.number,
        "state": revision.state,
        "source": revision.source,
        "message": revision.message,
        "lock_version": revision.lock_version,
        "tree_hash": revision.tree_hash,
        "author": name(revision.author_id),
        "created_at": revision.created_at,
        "updated_at": revision.updated_at,
        "published_by": name(revision.published_by),
        "published_at": revision.published_at,
        "repo_status": revision.repo_status,
        "repo_ref": revision.repo_ref,
        "repo_error": revision.repo_error,
    }


async def _users_by_id(session, ids) -> dict[int, User]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = (await session.execute(select(User).where(User.id.in_(ids)))).scalars()
    return {u.id: u for u in rows}


async def _node_out(session, record: NodeRecord, detail: bool = False) -> dict:
    published = await svc.get_revision(session, record.published_revision_id)
    draft = await svc.get_revision(session, record.draft_revision_id)
    served = {n.node.slug: n for n in get_deployment().node_list}
    node = served.get(record.slug)
    admins = (
        (
            await session.execute(
                select(User)
                .join(NodeAdmin, NodeAdmin.user_id == User.id)
                .where(NodeAdmin.node == record.slug)
                .order_by(User.name)
            )
        )
        .scalars()
        .all()
    )
    revisions = []
    if detail:
        revisions = (
            (
                await session.execute(
                    select(NodeRevision)
                    .where(NodeRevision.node == record.slug, NodeRevision.state != "draft")
                    .order_by(NodeRevision.number.desc())
                    .limit(100)
                )
            )
            .scalars()
            .all()
        )
    users = await _users_by_id(
        session,
        [r.author_id for r in [published, draft, *revisions] if r]
        + [r.published_by for r in [published, *revisions] if r],
    )
    out = {
        "slug": record.slug,
        "key": record.key,
        "title": node.node.title if node else None,
        "color": node.node.color if node else None,
        "served": node is not None,
        "published": _revision_out(published, users),
        "draft": _revision_out(draft, users),
        "draft_is_stale": bool(draft and published and draft.parent_id not in (None, published.id)),
        "admins": [{"id": u.id, "name": u.name, "email": u.email} for u in admins],
    }
    if detail:
        out["revisions"] = [_revision_out(r, users) for r in revisions]
        out["plugins"] = sorted(all_plugins())
    return out


@router.get("/config")
async def admin_config(user: AnyAdmin) -> dict:
    """What the admin UI needs to know about this deployment."""
    settings = get_settings()
    return {
        "editing": svc.enabled(),
        "publish_to": settings.config_publish,
        "repository": settings.github_repo if settings.config_publish == "github" else None,
        "is_super_admin": user.is_admin,
        "admin_nodes": user.admin_nodes,
    }


@router.get("/nodes")
async def list_nodes(session: SessionDep, user: AnyAdmin) -> list[dict]:
    require_editing()
    records = (await session.execute(select(NodeRecord).order_by(NodeRecord.key))).scalars()
    return [await _node_out(session, r) for r in records.all() if user.is_node_admin(r.slug)]


class NodeCreateIn(BaseModel):
    slug: str
    key: str
    title: str = Field(min_length=1, max_length=255)
    template: str  # slug of the node whose data models and vocabularies to copy


@router.post("/nodes", status_code=201)
async def create_node(payload: NodeCreateIn, session: SessionDep, user: SuperAdmin):
    require_editing()
    try:
        record = await svc.create_node(
            session,
            user,
            payload.slug.strip(),
            payload.key.strip(),
            payload.title.strip(),
            payload.template,
        )
    except (svc.ConfigError, svc.Conflict, KeyError) as exc:
        raise _errors(exc) from None
    await session.commit()
    return await _node_out(session, record, detail=True)


@router.get("/nodes/{slug}")
async def get_node(record: AdminNode, session: SessionDep):
    return await _node_out(session, record, detail=True)


# --- node admins --------------------------------------------------------------


@router.put("/nodes/{slug}/admins/{user_id}", status_code=204)
async def add_node_admin(record: AdminNode, user_id: int, session: SessionDep, user: CurrentUser):
    target = await session.get(User, user_id)
    if target is None:
        raise HTTPException(404, "user not found")
    if await session.get(NodeAdmin, (user_id, record.slug)) is None:
        session.add(NodeAdmin(user_id=user_id, node=record.slug, granted_by=user.id))
        await session.commit()


@router.delete("/nodes/{slug}/admins/{user_id}", status_code=204)
async def remove_node_admin(
    record: AdminNode, user_id: int, session: SessionDep, user: CurrentUser
):
    role = await session.get(NodeAdmin, (user_id, record.slug))
    if role is not None:
        await session.delete(role)
        await session.commit()


# --- configuration files and drafts -------------------------------------------


def _which(rev: str) -> str:
    if rev in ("draft", "published", "current") or rev.isdigit():
        return rev
    raise HTTPException(422, "rev is draft, published, current or a revision number")


async def _revision(session, record: NodeRecord, rev: str) -> NodeRevision:
    try:
        return await svc.revision_for(session, record, _which(rev))
    except KeyError:
        raise HTTPException(404, f"no {rev} revision of {record.slug}") from None


@router.get("/nodes/{slug}/files")
async def list_files(record: AdminNode, session: SessionDep, rev: str = "current"):
    revision = await _revision(session, record, rev)
    return {
        "revision": revision.number,
        "state": revision.state,
        "lock_version": revision.lock_version,
        "files": [{"path": p, "sha256": h} for p, h in sorted(revision.files.items())],
        "changes": await svc.diff(session, record, revision),
    }


@router.get("/nodes/{slug}/file")
async def read_file(record: AdminNode, session: SessionDep, path: str, rev: str = "current"):
    revision = await _revision(session, record, rev)
    try:
        content = await svc.read_file(session, revision, path)
    except KeyError:
        raise HTTPException(404, f"{path} not in revision {revision.number}") from None
    text = svc.is_text(content)
    return {
        "path": path,
        "revision": revision.number,
        "state": revision.state,
        "lock_version": revision.lock_version,
        "size": len(content),
        "encoding": "utf-8" if text else "base64",
        "content": content.decode() if text else base64.b64encode(content).decode(),
    }


@router.get("/nodes/{slug}/settings")
async def read_settings(record: AdminNode, session: SessionDep, rev: str = "current"):
    """The node YAML as JSON (for the settings form)."""
    revision = await _revision(session, record, rev)
    content = await svc.read_file(session, revision, f"{record.slug}.yaml")
    return {
        "revision": revision.number,
        "state": revision.state,
        "lock_version": revision.lock_version,
        "settings": yaml.safe_load(content),
    }


class FileIn(BaseModel):
    path: str
    content: str
    encoding: Literal["utf-8", "base64"] = "utf-8"
    lock_version: int | None = None


def _draft_out(draft: NodeRevision) -> dict:
    return {"revision": draft.number, "lock_version": draft.lock_version}


@router.put("/nodes/{slug}/draft/file")
async def put_file(record: AdminNode, payload: FileIn, session: SessionDep, user: CurrentUser):
    content = (
        base64.b64decode(payload.content)
        if payload.encoding == "base64"
        else payload.content.encode()
    )
    try:
        draft = await svc.put_file(
            session, record, user, payload.path, content, payload.lock_version
        )
    except (svc.ConfigError, svc.Conflict, KeyError) as exc:
        raise _errors(exc) from None
    await session.commit()
    return _draft_out(draft)


@router.delete("/nodes/{slug}/draft/file")
async def delete_file(
    record: AdminNode,
    session: SessionDep,
    user: CurrentUser,
    path: str,
    lock_version: int | None = None,
):
    try:
        draft = await svc.delete_file(session, record, user, path, lock_version)
    except (svc.ConfigError, svc.Conflict, KeyError) as exc:
        raise _errors(exc) from None
    await session.commit()
    return _draft_out(draft)


class SettingsOp(BaseModel):
    path: list[str | int] = Field(min_length=1)
    value: Any = None  # null deletes the key


class SettingsPatchIn(BaseModel):
    ops: list[SettingsOp]
    lock_version: int | None = None


@router.patch("/nodes/{slug}/draft/settings")
async def patch_settings(
    record: AdminNode, payload: SettingsPatchIn, session: SessionDep, user: CurrentUser
):
    """Edit the node YAML field by field, keeping its comments and layout."""
    try:
        draft = await svc.patch_settings(
            session, record, user, [op.model_dump() for op in payload.ops], payload.lock_version
        )
    except (svc.ConfigError, svc.Conflict, KeyError) as exc:
        raise _errors(exc) from None
    await session.commit()
    return _draft_out(draft)


class DraftIn(BaseModel):
    from_revision: int | None = None  # start from an older revision (roll back)


@router.post("/nodes/{slug}/draft")
async def open_draft(
    record: AdminNode, session: SessionDep, user: CurrentUser, payload: DraftIn | None = None
):
    try:
        draft = await svc.open_draft(
            session, record, user, payload.from_revision if payload else None
        )
    except (svc.Conflict, KeyError) as exc:
        raise _errors(exc) from None
    await session.commit()
    return _draft_out(draft)


@router.delete("/nodes/{slug}/draft", status_code=204)
async def discard_draft(record: AdminNode, session: SessionDep):
    try:
        await svc.discard_draft(session, record)
    except KeyError as exc:
        raise _errors(exc) from None
    await session.commit()


@router.get("/nodes/{slug}/validate")
async def validate(record: AdminNode, session: SessionDep, user: CurrentUser, rev: str = "current"):
    """Load a revision exactly as the API would. Also lists the protected
    settings it changes (which only a super admin can publish)."""
    revision = await _revision(session, record, rev)
    errors: list[str] = []
    try:
        await svc.validate_revision(session, record, revision)
    except svc.ConfigError as exc:
        errors = exc.errors
    protected: list[str] = []
    published = await svc.get_revision(session, record.published_revision_id)
    if published is not None and published.id != revision.id:
        yaml_path = f"{record.slug}.yaml"
        protected = svc.protected_changes(
            await svc.read_file(session, published, yaml_path),
            await svc.read_file(session, revision, yaml_path),
        )
    return {
        "ok": not errors,
        "errors": errors,
        "protected_changes": protected,
        "can_publish": not errors and (user.is_admin or not protected),
        "changes": await svc.diff(session, record, revision),
    }


class PublishIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    lock_version: int | None = None


async def _write_to_repo(revision: NodeRevision) -> None:
    mode = get_settings().config_publish
    if mode == "files":
        from fiesta.services.node_publish import write_revision

        await write_revision(revision.id)
    elif mode == "github":
        from fiesta.jobs.tasks import publish_node_config

        await publish_node_config.defer_async(revision_id=revision.id)


@router.post("/nodes/{slug}/publish")
async def publish(record: AdminNode, payload: PublishIn, session: SessionDep, user: CurrentUser):
    try:
        revision = await svc.publish(session, record, user, payload.lock_version, payload.message)
    except (svc.ConfigError, svc.Conflict, PermissionError, KeyError) as exc:
        raise _errors(exc) from None
    await session.commit()
    await svc.refresh_deployment(force=True)
    await _write_to_repo(revision)
    await session.refresh(revision)
    return await _node_out(session, record, detail=True)


@router.post("/nodes/{slug}/revisions/{number}/write", status_code=202)
async def retry_write(record: AdminNode, number: int, session: SessionDep):
    """Write a published revision to the repository again (after a failure)."""
    revision = await _revision(session, record, str(number))
    if revision.id != record.published_revision_id:
        raise HTTPException(409, "only the published revision is written to the repository")
    revision.repo_status = "pending"
    revision.repo_error = None
    await session.commit()
    await _write_to_repo(revision)
    return {"repo_status": "pending"}
