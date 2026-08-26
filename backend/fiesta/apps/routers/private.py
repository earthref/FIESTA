"""Private workspace: the contribution workflow (Bearer auth)."""

from fastapi import APIRouter, HTTPException, UploadFile
from sqlalchemy import select

from fiesta.apps.deps import CurrentUser, NodeDep, SessionDep
from fiesta.apps.schemas import ContributionOut, JobOut, ReferenceIn, ValidationOut
from fiesta.db.models import Contribution, ContributionStatus
from fiesta.jobs import tasks
from fiesta.search.client import get_opensearch
from fiesta.search.documents import update_contribution_flags
from fiesta.services import contributions as svc

router = APIRouter(prefix="/private/contributions", tags=["private"])


async def _own_contribution(
    session, node, user, contribution_id: int, *, allow_activated: bool = True
) -> Contribution:
    contribution = await session.get(Contribution, contribution_id)
    if (
        contribution is None
        or contribution.node != node.node.slug
        or (contribution.contributor_id != user.id and not user.is_admin)
    ):
        raise HTTPException(404, f"contribution {contribution_id} not found")
    if not allow_activated and contribution.is_activated:
        raise HTTPException(409, "contribution is published; deactivate it first")
    return contribution


def _out(contribution: Contribution, user) -> ContributionOut:
    return ContributionOut.from_db(
        contribution, include_private_key=True, contributor_name=user.name
    )


@router.get("", response_model=list[ContributionOut])
async def list_contributions(
    session: SessionDep, node: NodeDep, user: CurrentUser
) -> list[ContributionOut]:
    result = await session.execute(
        select(Contribution)
        .where(Contribution.contributor_id == user.id, Contribution.node == node.node.slug)
        .order_by(Contribution.created_at.desc())
    )
    return [_out(c, user) for c in result.scalars()]


@router.post("", response_model=ContributionOut, status_code=201)
async def create_contribution(
    session: SessionDep, node: NodeDep, user: CurrentUser
) -> ContributionOut:
    contribution = Contribution(
        node=node.node.slug, contributor_id=user.id, data_model_version=node.data_model.latest
    )
    session.add(contribution)
    await session.commit()
    await svc.save_manifest(node, contribution, user)
    return _out(contribution, user)


@router.get("/{contribution_id}", response_model=ContributionOut)
async def get_contribution(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> ContributionOut:
    contribution = await _own_contribution(session, node, user, contribution_id)
    return _out(contribution, user)


@router.put("/{contribution_id}/file", response_model=ContributionOut)
async def upload_file(
    session: SessionDep,
    node: NodeDep,
    user: CurrentUser,
    contribution_id: int,
    file: UploadFile,
) -> ContributionOut:
    contribution = await _own_contribution(
        session, node, user, contribution_id, allow_activated=False
    )
    data = await file.read()
    if not data:
        raise HTTPException(422, "uploaded file is empty")
    contribution.filename = svc.default_filename(node, contribution.id)
    contribution.status = ContributionStatus.UPLOADED
    contribution.error = None
    await session.commit()
    await svc.store_file(node, contribution, data)
    await svc.save_manifest(node, contribution, user)
    await tasks.defer_process_contribution(node, contribution.id)
    return _out(contribution, user)


@router.post("/{contribution_id}/validate", response_model=JobOut)
async def validate(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> JobOut:
    contribution = await _own_contribution(session, node, user, contribution_id)
    if not contribution.filename:
        raise HTTPException(409, "upload a file before validating")
    job_id = await tasks.defer_process_contribution(node, contribution.id)
    return JobOut(job_id=job_id)


@router.get("/{contribution_id}/validation", response_model=ValidationOut)
async def get_validation(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> ValidationOut:
    await _own_contribution(session, node, user, contribution_id)
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
    contribution.reference_doi = payload.doi.strip()
    await session.commit()
    await svc.save_manifest(node, contribution, user)
    await update_contribution_flags(
        get_opensearch(),
        node.search.index,
        contribution.id,
        {"_reference": {"doi": contribution.reference_doi}},
    )
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
    await svc.activate(session, node, contribution)
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
    await svc.deactivate(session, node, contribution)
    return _out(contribution, user)


@router.delete("/{contribution_id}", status_code=204)
async def delete(
    session: SessionDep, node: NodeDep, user: CurrentUser, contribution_id: int
) -> None:
    contribution = await _own_contribution(
        session, node, user, contribution_id, allow_activated=False
    )
    await svc.delete_contribution(session, node, contribution)
