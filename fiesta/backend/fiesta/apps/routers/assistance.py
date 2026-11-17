"""Assistance requests: a user asks the node's admins for help with one of
their contributions (approve a version they prepared, reassign it, trouble
validating, other). The request shares the contribution with the node's
admins, who can already open it (`can_access`); it puts the contribution on
their Requests tab, where they open, edit, validate, publish or reassign it and
resolve the request with a note. Opening and resolving one send email; every
change is an audit event."""

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from fiesta.apps.deps import CurrentUser, NodeDep, SessionDep, require_public_contributions
from fiesta.apps.routers.private import workspace_out
from fiesta.apps.schemas import ContributionOut
from fiesta.db.models import AssistanceRequest, AuditEvent, Contribution, NodeAdmin, User
from fiesta.jobs import tasks
from fiesta.services import contributions as svc
from fiesta.services.access import can_access

# Writes are refused in data-source mode, like every private workspace write.
router = APIRouter(
    prefix="/private",
    tags=["private"],
    dependencies=[Depends(require_public_contributions)],
)

Reason = Literal["approve", "reassign", "validation", "other"]
REASONS: dict[str, str] = {
    "approve": "approve a new version",
    "reassign": "reassign the contribution",
    "validation": "trouble validating",
    "other": "other",
}


class RequestIn(BaseModel):
    reason: Reason
    message: str = Field("", max_length=5000)


class ResolveIn(BaseModel):
    note: str = Field("", max_length=5000)


class ValidationState(BaseModel):
    is_valid: bool
    errors: int
    warnings: int
    validated_at: datetime


class RequestOut(BaseModel):
    id: int
    contribution_id: int
    requester_id: int
    requester_name: str | None = None
    requester_handle: str | None = None
    reason: str
    message: str
    state: str
    created_at: datetime
    closed_at: datetime | None = None
    closed_by: int | None = None
    closed_by_name: str | None = None
    note: str | None = None
    # With `?scope=node` (the admins' Requests tab): the contribution as the
    # caller's workspace shows it, and its head revision's validation.
    contribution: ContributionOut | None = None
    validation: ValidationState | None = None


async def _request_out(session, request: AssistanceRequest) -> RequestOut:
    requester = await session.get(User, request.requester_id)
    closer = await session.get(User, request.closed_by) if request.closed_by else None
    return RequestOut(
        id=request.id,
        contribution_id=request.contribution_id,
        requester_id=request.requester_id,
        requester_name=requester.name if requester else None,
        requester_handle=requester.handle if requester else None,
        reason=request.reason,
        message=request.message or "",
        state=request.state,
        created_at=request.created_at,
        closed_at=request.closed_at,
        closed_by=request.closed_by,
        closed_by_name=closer.name if closer else None,
        note=request.note,
    )


async def _visible_contribution(session, node, user, contribution_id: int, *, write=False):
    contribution = await session.get(Contribution, contribution_id)
    if (
        contribution is None
        or contribution.deleted_at is not None
        or contribution.node != node.node.slug
        or not await can_access(session, contribution, user, write=write)
    ):
        raise HTTPException(404, f"contribution {contribution_id} not found")
    return contribution


async def _visible_request(session, node, user, request_id: int):
    """The request and its contribution, for its requester, the
    contribution's contributor, or an admin of the node; 404 for anyone else."""
    request = await session.get(AssistanceRequest, request_id)
    contribution = await session.get(Contribution, request.contribution_id) if request else None
    if (
        request is None
        or contribution is None
        or contribution.node != node.node.slug
        or not (
            user.id in (request.requester_id, contribution.contributor_id)
            or user.is_node_admin(node.node.slug)
        )
    ):
        raise HTTPException(404, f"request {request_id} not found")
    return request, contribution


async def node_admin_emails(session, slug: str) -> list[str]:
    """Where a new request is sent: the node's admins, else (a node without
    any yet) the super admins."""
    admins = (
        await session.execute(
            select(User).join(NodeAdmin, NodeAdmin.user_id == User.id).where(NodeAdmin.node == slug)
        )
    ).scalars()
    emails = sorted({u.email for u in admins})
    if not emails:
        supers = (await session.execute(select(User).where(User.is_admin.is_(True)))).scalars()
        emails = sorted({u.email for u in supers})
    return emails


def _workspace_url(node) -> str:
    return f"{(node.node.links.website or '').rstrip('/')}/Private"


@router.get("/requests", response_model=list[RequestOut])
async def list_requests(
    session: SessionDep,
    node: NodeDep,
    user: CurrentUser,
    scope: Literal["mine", "node"] = "mine",
    state: Literal["open", "all"] = "all",
) -> list[RequestOut]:
    """`mine` (default): requests the caller made or that concern their
    contributions, newest first. `node` (node admins only): every request on
    the node's contributions, with each contribution and its validation."""
    slug = node.node.slug
    if scope == "node" and not user.is_node_admin(slug):
        raise HTTPException(403, "only a node admin sees the node's requests")
    stmt = (
        select(AssistanceRequest)
        .join(Contribution, Contribution.id == AssistanceRequest.contribution_id)
        .where(Contribution.node == slug, Contribution.deleted_at.is_(None))
        .order_by(AssistanceRequest.created_at.desc())
    )
    if state == "open":
        stmt = stmt.where(AssistanceRequest.state == "open")
    if scope == "mine":
        stmt = stmt.where(
            (AssistanceRequest.requester_id == user.id) | (Contribution.contributor_id == user.id)
        )
    output = []
    for request in (await session.execute(stmt)).scalars():
        contribution = await session.get(Contribution, request.contribution_id)
        # The query decides; this re-checks what it was asked, row by row.
        if contribution is None or contribution.node != slug or contribution.deleted_at:
            continue
        if state == "open" and request.state != "open":
            continue
        if scope == "mine" and user.id not in (request.requester_id, contribution.contributor_id):
            continue
        out = await _request_out(session, request)
        if scope == "node":
            out.contribution = await workspace_out(session, contribution, user)
            if report := await svc.latest_validation(session, contribution.id):
                out.validation = ValidationState(
                    is_valid=report.is_valid,
                    errors=len(report.errors or []),
                    warnings=len(report.warnings or []),
                    validated_at=report.validated_at,
                )
        output.append(out)
    return output


@router.get("/contributions/{contribution_id}/requests", response_model=list[RequestOut])
async def contribution_requests(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> list[RequestOut]:
    """The contribution's requests, newest first, for whoever may open it."""
    await _visible_contribution(session, node, user, contribution_id)
    rows = (
        await session.execute(
            select(AssistanceRequest)
            .where(AssistanceRequest.contribution_id == contribution_id)
            .order_by(AssistanceRequest.created_at.desc())
        )
    ).scalars()
    return [await _request_out(session, r) for r in rows if r.contribution_id == contribution_id]


@router.post(
    "/contributions/{contribution_id}/requests", response_model=RequestOut, status_code=201
)
async def open_request(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int, payload: RequestIn
) -> RequestOut:
    """Ask the node's admins for help with a contribution the caller may save
    (one open request per contribution); the admins get an email."""
    contribution = await _visible_contribution(session, node, user, contribution_id, write=True)
    existing = (
        await session.execute(
            select(AssistanceRequest).where(
                AssistanceRequest.contribution_id == contribution.id,
                AssistanceRequest.state == "open",
            )
        )
    ).scalars()
    if any(r.contribution_id == contribution.id and r.state == "open" for r in existing):
        raise HTTPException(409, "this contribution already has an open request")
    request = AssistanceRequest(
        contribution_id=contribution.id,
        requester_id=user.id,
        reason=payload.reason,
        message=payload.message.strip(),
        state="open",
        created_at=datetime.now(UTC),
    )
    session.add(request)
    await session.flush()
    session.add(
        AuditEvent(
            contribution_id=contribution.id,
            actor_id=user.id,
            operation="request-open",
            details={"request": request.id, "reason": payload.reason},
        )
    )
    await session.commit()
    key = node.node.key
    body = (
        f"{user.name} ({user.email}) asks the {key} admins for help with contribution "
        f"{contribution.id} (version {contribution.version}).\n\n"
        f"Reason: {REASONS[payload.reason]}\n\n{request.message or '(no message)'}\n\n"
        f"Open it on the Requests tab of the private workspace: {_workspace_url(node)}"
    )
    for to in await node_admin_emails(session, node.node.slug):
        await tasks.send_email.defer_async(
            to=to,
            subject=f"[{key}] Request: {REASONS[payload.reason]} (contribution {contribution.id})",
            body=body,
        )
    return await _request_out(session, request)


@router.post("/requests/{request_id}/withdraw", response_model=RequestOut)
async def withdraw_request(
    session: SessionDep, node: NodeDep, user: CurrentUser, request_id: int
) -> RequestOut:
    """The requester (or the contribution's contributor) takes it back."""
    request, contribution = await _visible_request(session, node, user, request_id)
    if user.id not in (request.requester_id, contribution.contributor_id):
        raise HTTPException(403, "only the requester can withdraw a request")
    if request.state != "open":
        raise HTTPException(409, f"the request is already {request.state}")
    request.state = "withdrawn"
    request.closed_at = datetime.now(UTC)
    request.closed_by = user.id
    session.add(
        AuditEvent(
            contribution_id=contribution.id,
            actor_id=user.id,
            operation="request-withdraw",
            details={"request": request.id},
        )
    )
    await session.commit()
    return await _request_out(session, request)


@router.post("/requests/{request_id}/resolve", response_model=RequestOut)
async def resolve_request(
    session: SessionDep, node: NodeDep, user: CurrentUser, request_id: int, payload: ResolveIn
) -> RequestOut:
    """A node admin closes the request with a note for the requester, who is
    emailed."""
    if not user.is_node_admin(node.node.slug):
        raise HTTPException(403, "only a node admin resolves a request")
    request, contribution = await _visible_request(session, node, user, request_id)
    if request.state != "open":
        raise HTTPException(409, f"the request is already {request.state}")
    request.state = "resolved"
    request.closed_at = datetime.now(UTC)
    request.closed_by = user.id
    request.note = payload.note.strip() or None
    session.add(
        AuditEvent(
            contribution_id=contribution.id,
            actor_id=user.id,
            operation="request-resolve",
            details={"request": request.id},
        )
    )
    await session.commit()
    requester = await session.get(User, request.requester_id)
    if requester is not None:
        key = node.node.key
        await tasks.send_email.defer_async(
            to=requester.email,
            subject=f"[{key}] Request resolved (contribution {contribution.id})",
            body=(
                f"{user.name} resolved your request "
                f"({REASONS.get(request.reason, request.reason)}) for contribution "
                f"{contribution.id}.\n\n{request.note or '(no note)'}\n\n"
                f"Your private workspace: {_workspace_url(node)}"
            ),
        )
    return await _request_out(session, request)
