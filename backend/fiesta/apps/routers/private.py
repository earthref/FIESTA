"""Private workspace: the contribution workflow (Bearer auth)."""

import uuid

from fastapi import APIRouter, Header, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import select

from fiesta.apps.deps import CurrentUser, NodeDep, SessionDep
from fiesta.apps.schemas import ContributionOut, JobOut, ReferenceIn, ValidationOut
from fiesta.db.models import Contribution, ContributionStatus, Revision, User
from fiesta.jobs import tasks
from fiesta.services import contributions as svc
from fiesta.services.access import can_access
from fiesta.services.revisions import locked, revision_file, save_revision, snapshot_for

router = APIRouter(prefix="/private/contributions", tags=["private"])


async def _own_contribution(
    session, node, user, contribution_id: int, *, allow_activated: bool = True, write: bool = True
) -> Contribution:
    contribution = await session.get(Contribution, contribution_id)
    if (
        contribution is None
        or contribution.deleted_at is not None
        or contribution.node != node.node.slug
        or not await can_access(session, contribution, user, write=write)
    ):
        raise HTTPException(404, f"contribution {contribution_id} not found")
    if not allow_activated and contribution.is_activated:
        raise HTTPException(409, "published content is immutable; create a new version")
    return contribution


def _out(contribution: Contribution, user) -> ContributionOut:
    return ContributionOut.from_db(
        contribution,
        include_private_key=(
            contribution.contributor_id == user.id or user.is_node_admin(contribution.node)
        ),
        contributor_name=user.name if contribution.contributor_id == user.id else None,
    )


@router.get("", response_model=list[ContributionOut])
async def list_contributions(
    session: SessionDep, node: NodeDep, user: CurrentUser
) -> list[ContributionOut]:
    result = await session.execute(
        select(Contribution)
        .where(Contribution.node == node.node.slug, Contribution.deleted_at.is_(None))
        .order_by(Contribution.created_at.desc())
    )
    output = []
    for c in result.scalars():
        if await can_access(session, c, user):
            owner = await session.get(User, c.contributor_id)
            output.append(
                ContributionOut.from_db(
                    c,
                    include_private_key=(c.contributor_id == user.id or user.is_node_admin(c.node)),
                    contributor_name=owner.name,
                )
            )
    return output


@router.post("", response_model=ContributionOut, status_code=201)
async def create_contribution(
    session: SessionDep, node: NodeDep, user: CurrentUser
) -> ContributionOut:
    contribution = Contribution(
        node=node.node.slug, contributor_id=user.id, data_model_version=node.data_model.latest
    )
    session.add(contribution)
    await session.commit()
    return _out(contribution, user)


@router.get("/{contribution_id}", response_model=ContributionOut)
async def get_contribution(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> ContributionOut:
    contribution = await _own_contribution(session, node, user, contribution_id, write=False)
    return _out(contribution, user)


@router.put("/{contribution_id}/file", response_model=ContributionOut)
async def upload_file(
    session: SessionDep,
    node: NodeDep,
    user: CurrentUser,
    contribution_id: int,
    file: UploadFile,
    expected_revision: str | None = Header(None, alias="If-Match"),
    request_key: str = Header(..., alias="Idempotency-Key"),
) -> ContributionOut:
    contribution = await _own_contribution(
        session, node, user, contribution_id, allow_activated=False
    )
    data = await file.read()
    if not data:
        raise HTTPException(422, "uploaded file is empty")
    await save_revision(
        session,
        node,
        contribution,
        user.id,
        expected_revision=expected_revision,
        request_key=request_key,
        files={svc.default_filename(node, contribution.id): data},
        canonical=svc.default_filename(node, contribution.id),
        operation="upload",
    )
    await session.commit()
    return _out(contribution, user)


@router.post("/{contribution_id}/validate", response_model=JobOut)
async def validate(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> JobOut:
    contribution = await _own_contribution(session, node, user, contribution_id)
    if not contribution.filename:
        raise HTTPException(409, "upload a file before validating")
    from fiesta.db.models import Outbox

    event = Outbox(
        contribution_id=contribution.id, revision_id=contribution.head_revision, kind="process"
    )
    session.add(event)
    await session.commit()
    return JobOut(job_id=event.id)


@router.get("/{contribution_id}/validation", response_model=ValidationOut)
async def get_validation(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> ValidationOut:
    await _own_contribution(session, node, user, contribution_id, write=False)
    result = await svc.latest_validation(session, contribution_id)
    if result is None:
        raise HTTPException(404, "this contribution has not been validated yet")
    return ValidationOut(
        is_valid=result.is_valid,
        validated_at=result.validated_at,
        errors=result.errors,
        warnings=result.warnings,
    )


@router.put("/{contribution_id}/reference", response_model=ContributionOut)
async def set_reference(
    session: SessionDep,
    node: NodeDep,
    user: CurrentUser,
    contribution_id: int,
    payload: ReferenceIn,
) -> ContributionOut:
    contribution = await _own_contribution(session, node, user, contribution_id)
    await save_revision(
        session,
        node,
        contribution,
        user.id,
        expected_revision=payload.expected_revision,
        request_key=payload.request_key,
        reference_doi=payload.doi.strip(),
        operation="reference",
    )
    await session.commit()
    return _out(contribution, user)


@router.post("/{contribution_id}/activate", response_model=ContributionOut)
async def activate(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> ContributionOut:
    contribution = await _own_contribution(session, node, user, contribution_id)
    if contribution.is_activated:
        raise HTTPException(409, "contribution is already published")
    if contribution.status != ContributionStatus.READY:
        raise HTTPException(
            409, f"contribution is not ready to publish (status: {contribution.status.value})"
        )
    validation = await svc.latest_validation(session, contribution_id)
    if validation is None or not validation.is_valid:
        raise HTTPException(409, "contribution must pass validation before publishing")
    await svc.activate(session, node, contribution, actor_id=user.id)
    await tasks.send_email.defer_async(
        to=user.email,
        subject=f"[{node.node.key}] Contribution {contribution.id} published",
        body=(
            f"Your contribution {contribution.id} is now published at "
            f"{node.node.links.website or ''}/contributions/{contribution.id}"
        ),
    )
    return _out(contribution, user)


@router.post("/{contribution_id}/deactivate", response_model=ContributionOut)
async def deactivate(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> ContributionOut:
    contribution = await _own_contribution(session, node, user, contribution_id)
    if not contribution.is_activated:
        raise HTTPException(409, "contribution is not published")
    await svc.deactivate(session, node, contribution, actor_id=user.id)
    return _out(contribution, user)


@router.delete("/{contribution_id}", status_code=204)
async def delete(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> None:
    contribution = await _own_contribution(
        session, node, user, contribution_id, allow_activated=False
    )
    await svc.delete_contribution(session, node, contribution, actor_id=user.id)


class EditIn(BaseModel):
    expected_revision: str | None
    request_key: str
    text: str


class RestoreIn(BaseModel):
    expected_revision: str | None
    request_key: str


@router.get("/{contribution_id}/revisions")
async def history(session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int):
    await _own_contribution(session, node, user, contribution_id, write=False)
    rows = (
        await session.execute(
            select(Revision)
            .where(Revision.contribution_id == contribution_id)
            .order_by(Revision.created_at.desc())
        )
    ).scalars()
    return [
        {
            "id": r.id,
            "parent_id": r.parent_id,
            "actor_id": r.actor_id,
            "operation": r.operation,
            "created_at": r.created_at,
            "files": list(r.snapshot["files"]),
        }
        for r in rows
    ]


@router.get("/{contribution_id}/content")
async def content(
    session: SessionDep,
    node: NodeDep,
    user: CurrentUser,
    contribution_id: int,
    revision_id: str | None = None,
):
    c = await _own_contribution(session, node, user, contribution_id, write=False)
    data = await revision_file(session, node, c, revision_id=revision_id)
    return {"revision_id": revision_id or c.head_revision, "text": data.decode("utf-8")}


@router.put("/{contribution_id}/content", response_model=ContributionOut)
async def edit(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int, payload: EditIn
):
    c = await _own_contribution(session, node, user, contribution_id)
    name = c.filename or svc.default_filename(node, c.id)
    await save_revision(
        session,
        node,
        c,
        user.id,
        expected_revision=payload.expected_revision,
        request_key=payload.request_key,
        files={name: payload.text.encode()},
        canonical=name,
        operation="edit",
    )
    await session.commit()
    return _out(c, user)


@router.post("/{contribution_id}/revisions/{revision_id}/restore", response_model=ContributionOut)
async def restore(
    session: SessionDep,
    node: NodeDep,
    user: CurrentUser,
    contribution_id: int,
    revision_id: str,
    payload: RestoreIn,
):
    c = await _own_contribution(session, node, user, contribution_id)
    await save_revision(
        session,
        node,
        c,
        user.id,
        expected_revision=payload.expected_revision,
        request_key=payload.request_key,
        restore=revision_id,
        operation="restore",
    )
    await session.commit()
    return _out(c, user)


@router.get("/{contribution_id}/attachments")
async def attachments(session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int):
    c = await _own_contribution(session, node, user, contribution_id, write=False)
    snapshot = await snapshot_for(session, c)
    return [
        {"name": n, "size": f["size"], "sha256": f["sha256"]}
        for n, f in snapshot["files"].items()
        if n != snapshot["canonical"]
    ]


@router.get("/{contribution_id}/attachments/{name}")
async def attachment_download(
    session: SessionDep,
    node: NodeDep,
    user: CurrentUser,
    contribution_id: int,
    name: str,
    revision_id: str | None = None,
):
    c = await _own_contribution(session, node, user, contribution_id, write=False)
    return Response(
        await revision_file(session, node, c, name, revision_id),
        media_type="application/octet-stream",
    )


@router.put("/{contribution_id}/attachments/{name}", response_model=ContributionOut)
async def attachment_upload(
    session: SessionDep,
    node: NodeDep,
    user: CurrentUser,
    contribution_id: int,
    name: str,
    file: UploadFile,
    expected_revision: str | None = Header(None, alias="If-Match"),
    request_key: str = Header(..., alias="Idempotency-Key"),
):
    c = await _own_contribution(session, node, user, contribution_id)
    await save_revision(
        session,
        node,
        c,
        user.id,
        expected_revision=expected_revision,
        request_key=request_key,
        files={name: await file.read()},
        operation="attachment",
    )
    await session.commit()
    return _out(c, user)


@router.delete("/{contribution_id}/attachments/{name}", response_model=ContributionOut)
async def attachment_remove(
    session: SessionDep,
    node: NodeDep,
    user: CurrentUser,
    contribution_id: int,
    name: str,
    payload: RestoreIn,
):
    c = await _own_contribution(session, node, user, contribution_id)
    await save_revision(
        session,
        node,
        c,
        user.id,
        expected_revision=payload.expected_revision,
        request_key=payload.request_key,
        remove=[name],
        operation="remove-attachment",
    )
    await session.commit()
    return _out(c, user)


@router.post("/{contribution_id}/versions", response_model=ContributionOut, status_code=201)
async def new_version(session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int):
    original = await _own_contribution(session, node, user, contribution_id)
    original = await locked(session, original.id)
    if not original.published_revision:
        raise HTTPException(409, "only a published contribution starts a new version")
    c = Contribution(
        node=node.node.slug,
        contributor_id=user.id,
        version=original.version + 1,
        previous_id=original.id,
        data_model_version=original.data_model_version,
        reference_doi=original.reference_doi,
        workspace_id=original.workspace_id,
    )
    session.add(c)
    await session.flush()
    snapshot = await snapshot_for(session, original)
    files = {n: await revision_file(session, node, original, n) for n in snapshot["files"]}
    await save_revision(
        session,
        node,
        c,
        user.id,
        expected_revision=None,
        request_key=str(uuid.uuid4()),
        files=files,
        canonical=snapshot["canonical"],
        reference_doi=snapshot["reference_doi"],
        operation="new-version",
    )
    await session.commit()
    return _out(c, user)


@router.get("/{contribution_id}/revisions/{revision_id}/validation")
async def historical_validation(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int, revision_id: str
):
    from fiesta.db.models import ValidationResult

    await _own_contribution(session, node, user, contribution_id, write=False)
    revision = await session.get(Revision, revision_id)
    if not revision or revision.contribution_id != contribution_id:
        raise HTTPException(404, "revision not found")
    reports = (
        await session.execute(
            select(ValidationResult)
            .where(
                ValidationResult.contribution_id == contribution_id,
                ValidationResult.revision_id == revision_id,
            )
            .order_by(ValidationResult.validated_at.desc())
        )
    ).scalars()
    return [
        {
            "id": r.id,
            "is_valid": r.is_valid,
            "validated_at": r.validated_at,
            "errors": r.errors,
            "warnings": r.warnings,
        }
        for r in reports
    ]
