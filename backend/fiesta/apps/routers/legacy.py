"""Routes kept for legacy api.earthref.org clients (HTTP Basic auth, the
singular `/private/contribution` shape, `/data` and `/download`). New clients
and the SPA use the `search`, `private` and `workspaces` routers instead."""

import io
import uuid
import zipfile

from fastapi import APIRouter, HTTPException, Query, Response, UploadFile
from opensearchpy.exceptions import NotFoundError
from sqlalchemy import select

from fiesta.apps.deps import BasicUser, NodeDep, SessionDep
from fiesta.apps.schemas import SearchPage
from fiesta.db.models import Contribution
from fiesta.domain.parse import ParseError, parse_text
from fiesta.domain.validate import guess_data_model_version, validate_contribution
from fiesta.nodeconfig import NodeConfig
from fiesta.search.client import get_opensearch
from fiesta.search.queries import build_search_body
from fiesta.services import contributions as svc
from fiesta.services.access import constrain_search
from fiesta.services.revisions import revision_file, save_revision, snapshot_for

router = APIRouter(tags=["legacy"])


async def _visible(
    session, node: NodeConfig, contribution_id: int, key: str | None
) -> Contribution:
    contribution = await session.get(Contribution, contribution_id)
    if (
        contribution is None
        or contribution.deleted_at is not None
        or contribution.node != node.node.slug
        or contribution.filename is None
    ):
        raise HTTPException(404, f"contribution {contribution_id} not found")
    if not contribution.is_activated and str(contribution.private_key) != (key or ""):
        raise HTTPException(404, f"contribution {contribution_id} not found")
    return contribution


async def _owned(session, node: NodeConfig, user, contribution_id: int) -> Contribution:
    contribution = await session.get(Contribution, contribution_id)
    if (
        contribution is None
        or contribution.deleted_at is not None
        or contribution.node != node.node.slug
        or (contribution.contributor_id != user.id and not user.is_admin)
    ):
        raise HTTPException(404, f"contribution {contribution_id} not found")
    return contribution


async def _store_and_process(session, node, contribution, user, file: UploadFile) -> None:
    data = await file.read()
    if not data:
        raise HTTPException(422, "uploaded file is empty")
    await save_revision(
        session,
        node,
        contribution,
        user.id,
        expected_revision=contribution.head_revision,
        request_key=str(uuid.uuid4()),
        files={svc.default_filename(node, contribution.id): data},
        canonical=svc.default_filename(node, contribution.id),
        operation="legacy-upload",
    )
    await session.commit()


@router.get("/data/{contribution_id}", tags=["data"])
async def get_data(
    session: SessionDep, node: NodeDep, contribution_id: int, key: str | None = None
) -> Response:
    contribution = await _visible(session, node, contribution_id, key)
    data = await svc.load_file(node, contribution.id, contribution.filename)
    return Response(
        content=data,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{contribution.filename}"'},
    )


@router.get("/download/{contribution_id}", tags=["data"])
async def download_zip(
    session: SessionDep, node: NodeDep, contribution_id: int, key: str | None = None
) -> Response:
    contribution = await _visible(session, node, contribution_id, key)
    data = await svc.load_file(node, contribution.id, contribution.filename)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        if contribution.head_revision:
            snapshot = await snapshot_for(session, contribution)
            for name in snapshot["files"]:
                archive.writestr(name, await revision_file(session, node, contribution, name))
        else:
            archive.writestr(contribution.filename, data)
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{node.node.slug}_contribution_{contribution.id}.zip"'
            )
        },
    )


@router.post("/validate", tags=["validation"])
async def validate_upload(node: NodeDep, file: UploadFile) -> dict:
    raw = await file.read()
    try:
        parsed = parse_text(raw.decode("utf-8", errors="replace"))
    except ParseError as exc:
        return {
            "is_valid": False,
            "errors": [{"table": None, "row": exc.line, "column": None, "message": str(exc)}],
            "warnings": [],
        }
    version = guess_data_model_version(node, parsed)
    return validate_contribution(node, parsed, version).as_dict()


@router.get("/private/search/{table}", response_model=SearchPage, tags=["private"])
async def private_search(
    session: SessionDep,
    node: NodeDep,
    user: BasicUser,
    table: str,
    query: str | None = None,
    size: int = Query(10, ge=1, le=1000),
    from_: int = Query(0, ge=0, alias="from"),
) -> SearchPage:
    body = build_search_body(
        table=table,
        query=query,
        size=size,
        from_=from_,
        contributor_id=user.id,
        private_only=True,
    )
    await constrain_search(session, node, body, user, query=query)
    try:
        response = await get_opensearch().search(index=node.search_index, body=body)
    except NotFoundError:
        return SearchPage(total=0, results=[])
    hits = response["hits"]
    total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]
    return SearchPage(total=total, results=[h["_source"] for h in hits["hits"]])


@router.post("/private/contribution", status_code=201, tags=["private"])
async def private_create(
    session: SessionDep, node: NodeDep, user: BasicUser, file: UploadFile | None = None
) -> dict:
    contribution = Contribution(
        node=node.node.slug,
        contributor_id=user.id,
        data_model_version=node.data_model.latest,
    )
    session.add(contribution)
    await session.commit()
    await svc.save_manifest(node, contribution, user)
    if file is not None:
        await _store_and_process(session, node, contribution, user, file)
    return {"id": contribution.id, "private_key": str(contribution.private_key)}


@router.put("/private/contribution/{contribution_id}", tags=["private"])
async def private_replace(
    session: SessionDep, node: NodeDep, user: BasicUser, contribution_id: int, file: UploadFile
) -> dict:
    contribution = await _owned(session, node, user, contribution_id)
    if contribution.is_activated:
        raise HTTPException(409, "published content is immutable; create a new version")
    await _store_and_process(session, node, contribution, user, file)
    return {"id": contribution.id, "status": contribution.status.value}


@router.delete("/private/contribution/{contribution_id}", status_code=204, tags=["private"])
async def private_delete(
    session: SessionDep, node: NodeDep, user: BasicUser, contribution_id: int
) -> None:
    contribution = await _owned(session, node, user, contribution_id)
    if contribution.is_activated:
        raise HTTPException(409, "cannot delete a published contribution")
    await svc.delete_contribution(session, node, contribution, actor_id=user.id)


@router.get("/private/contribution-list", tags=["private"])
async def private_list(session: SessionDep, node: NodeDep, user: BasicUser) -> list[dict]:
    result = await session.execute(
        select(Contribution)
        .where(
            Contribution.contributor_id == user.id,
            Contribution.node == node.node.slug,
            Contribution.deleted_at.is_(None),
        )
        .order_by(Contribution.created_at.desc())
    )
    return [
        {
            "id": c.id,
            "version": c.version,
            "is_activated": c.is_activated,
            "is_latest": c.is_latest,
            "status": c.status.value,
            "filename": c.filename,
            "created_at": c.created_at,
        }
        for c in result.scalars()
    ]
