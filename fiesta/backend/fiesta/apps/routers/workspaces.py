"""Shared workspace membership; owners control sharing, editors save, viewers read."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from fiesta.apps.deps import CurrentUser, NodeDep, SessionDep
from fiesta.db.models import AuditEvent, Contribution, User, Workspace, WorkspaceMember
from fiesta.services.access import workspace_owner

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class MemberIn(BaseModel):
    user_id: int
    role: Literal["viewer", "editor"]


@router.get("")
async def list_workspaces(session: SessionDep, user: CurrentUser, node: NodeDep):
    rows = (await session.execute(select(Workspace))).scalars()
    result = []
    for w in rows:
        member = await session.get(WorkspaceMember, (w.id, user.id))
        if user.is_node_admin(node.node.slug) or w.owner_id == user.id or member:
            result.append(
                {
                    "id": w.id,
                    "name": w.name,
                    "owner_id": w.owner_id,
                    "role": "owner"
                    if w.owner_id == user.id
                    else member.role
                    if member
                    else "admin",
                }
            )
    return result


@router.post("", status_code=201)
async def create_workspace(
    payload: WorkspaceIn, session: SessionDep, user: CurrentUser, node: NodeDep
):
    w = Workspace(name=payload.name, owner_id=user.id)
    session.add(w)
    await session.commit()
    return {"id": w.id, "name": w.name}


@router.put("/{workspace_id}/members")
async def member_put(
    workspace_id: int, payload: MemberIn, session: SessionDep, user: CurrentUser, node: NodeDep
):
    await workspace_owner(session, workspace_id, user, node.node.slug)
    if await session.get(User, payload.user_id) is None:
        raise HTTPException(404, "user not found")
    member = await session.get(WorkspaceMember, (workspace_id, payload.user_id))
    if member is None:
        member = WorkspaceMember(
            workspace_id=workspace_id, user_id=payload.user_id, role=payload.role
        )
        session.add(member)
    member.role = payload.role
    session.add(
        AuditEvent(
            actor_id=user.id,
            operation="workspace-grant",
            details={
                "workspace_id": workspace_id,
                "user_id": payload.user_id,
                "role": payload.role,
            },
        )
    )
    await session.commit()
    return {"role": member.role}


@router.delete("/{workspace_id}/members/{user_id}", status_code=204)
async def member_delete(
    workspace_id: int, user_id: int, session: SessionDep, user: CurrentUser, node: NodeDep
):
    await workspace_owner(session, workspace_id, user, node.node.slug)
    member = await session.get(WorkspaceMember, (workspace_id, user_id))
    if member:
        await session.delete(member)
    session.add(
        AuditEvent(
            actor_id=user.id,
            operation="workspace-revoke",
            details={"workspace_id": workspace_id, "user_id": user_id},
        )
    )
    await session.commit()


@router.put("/{workspace_id}/contributions/{contribution_id}")
async def assign(
    workspace_id: int, contribution_id: int, session: SessionDep, user: CurrentUser, node: NodeDep
):
    await workspace_owner(session, workspace_id, user, node.node.slug)
    c = await session.get(Contribution, contribution_id)
    if (
        c is None
        or c.deleted_at
        or (c.contributor_id != user.id and not user.is_node_admin(c.node))
    ):
        raise HTTPException(404, "contribution not found")
    c.workspace_id = workspace_id
    session.add(
        AuditEvent(
            actor_id=user.id,
            contribution_id=c.id,
            operation="workspace-assign",
            details={"workspace_id": workspace_id},
        )
    )
    await session.commit()
    return {"workspace_id": workspace_id}
