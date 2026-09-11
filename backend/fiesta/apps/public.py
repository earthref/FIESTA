"""Public API app (deployment: public-api) — the versioned /v1 REST surface
across all FIESTA nodes, compatible with the legacy api.earthref.org."""

import io
import zipfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Response, UploadFile
from opensearchpy.exceptions import NotFoundError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from fiesta.apps.deps import BasicUser, SessionDep
from fiesta.apps.schemas import SearchPage, UserOut
from fiesta.db.models import Contribution
from fiesta.db.session import get_sessionmaker
from fiesta.domain.parse import ParseError, parse_text
from fiesta.domain.validate import guess_data_model_version, validate_contribution
from fiesta.nodeconfig import NodeConfig, get_deployment
from fiesta.search.client import get_opensearch
from fiesta.search.queries import SORT_OPTIONS, build_search_body
from fiesta.services import contributions as svc


def get_public_api():
    deployment = get_deployment()
    if deployment.public_api is None:
        raise RuntimeError("this deployment is not the public API (deployment: node)")
    return deployment.public_api


def _node(repository: str) -> NodeConfig:
    try:
        return get_public_api().node_for(repository)
    except KeyError:
        raise HTTPException(404, f"unknown repository {repository!r}") from None


async def get_repo_session(repository: str) -> AsyncIterator[AsyncSession]:
    """Session bound to the schema of the node named in the path. The plain
    SessionDep (shared schema only) still serves users/auth and health."""
    async with get_sessionmaker(_node(repository).node.slug)() as session:
        yield session


RepoSession = Annotated[AsyncSession, Depends(get_repo_session)]


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await get_opensearch().close()


def create_app() -> FastAPI:
    public = get_public_api()
    app = FastAPI(
        title=public.title,
        version="1.0.0",
        license_info={"name": "MIT License", "url": "https://opensource.org/licenses/MIT"},
        lifespan=lifespan,
        docs_url="/v1/docs",
        openapi_url="/v1/openapi.json",
    )

    @app.get("/v1/health-check", tags=["health"])
    async def health_check(session: SessionDep) -> dict:
        database = search = False
        with suppress(Exception):
            await session.execute(text("SELECT 1"))
            database = True
        with suppress(Exception):
            search = bool(await get_opensearch().ping())
        return {
            "status": "ok" if database and search else "degraded",
            "database": database,
            "search": search,
            "repositories": sorted(n.node.key for n in public.nodes.values()),
        }

    @app.get("/v1/authenticate", response_model=UserOut, tags=["auth"])
    async def authenticate(user: BasicUser) -> UserOut:
        return UserOut.from_db(user)

    @app.get("/v1/{repository}/data/{contribution_id}", tags=["data"])
    async def get_data(
        session: RepoSession, repository: str, contribution_id: int, key: str | None = None
    ) -> Response:
        node = _node(repository)
        contribution = await _visible(session, node, contribution_id, key)
        data = await svc.load_file(node, contribution.id, contribution.filename)
        return Response(
            content=data,
            media_type="text/plain",
            headers={"Content-Disposition": f'attachment; filename="{contribution.filename}"'},
        )

    @app.get("/v1/{repository}/download/{contribution_id}", tags=["data"])
    async def download_zip(
        session: RepoSession, repository: str, contribution_id: int, key: str | None = None
    ) -> Response:
        node = _node(repository)
        contribution = await _visible(session, node, contribution_id, key)
        data = await svc.load_file(node, contribution.id, contribution.filename)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
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

    @app.get("/v1/{repository}/search/{table}", response_model=SearchPage, tags=["search"])
    async def search(
        repository: str,
        table: str,
        query: str | None = None,
        size: int = Query(10, ge=1, le=1000),
        from_: int = Query(0, ge=0, alias="from"),
        sort: str | None = None,
    ) -> SearchPage:
        node = _node(repository)
        tables = {lvl.table for lvl in node.search.levels} | set(node.search.extra_types)
        if table not in tables:
            raise HTTPException(404, f"unknown search table {table!r}")
        if sort is not None and sort not in SORT_OPTIONS:
            raise HTTPException(422, f"sort must be one of {sorted(SORT_OPTIONS)}")
        body = build_search_body(table=table, query=query, size=size, from_=from_, sort=sort)
        try:
            response = await get_opensearch().search(index=node.search_index, body=body)
        except NotFoundError:
            return SearchPage(total=0, results=[])
        hits = response["hits"]
        total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]
        return SearchPage(total=total, results=[h["_source"] for h in hits["hits"]])

    @app.post("/v1/{repository}/validate", tags=["validation"])
    async def validate_upload(repository: str, file: UploadFile) -> dict:
        node = _node(repository)
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

    async def _visible(
        session, node: NodeConfig, contribution_id: int, key: str | None
    ) -> Contribution:
        contribution = await session.get(Contribution, contribution_id)
        if (
            contribution is None
            or contribution.node != node.node.slug
            or contribution.filename is None
        ):
            raise HTTPException(404, f"contribution {contribution_id} not found")
        if not contribution.is_activated and str(contribution.private_key) != (key or ""):
            raise HTTPException(404, f"contribution {contribution_id} not found")
        return contribution

    @app.get("/v1/{repository}/private/search/{table}", response_model=SearchPage, tags=["private"])
    async def private_search(
        user: BasicUser,
        repository: str,
        table: str,
        query: str | None = None,
        size: int = Query(10, ge=1, le=1000),
        from_: int = Query(0, ge=0, alias="from"),
    ) -> SearchPage:
        node = _node(repository)
        body = build_search_body(
            table=table,
            query=query,
            size=size,
            from_=from_,
            contributor_id=user.id,
            private_only=True,
        )
        try:
            response = await get_opensearch().search(index=node.search_index, body=body)
        except NotFoundError:
            return SearchPage(total=0, results=[])
        hits = response["hits"]
        total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]
        return SearchPage(total=total, results=[h["_source"] for h in hits["hits"]])

    @app.post("/v1/{repository}/private/contribution", status_code=201, tags=["private"])
    async def private_create(
        user: BasicUser, session: RepoSession, repository: str, file: UploadFile | None = None
    ) -> dict:
        node = _node(repository)
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

    @app.put("/v1/{repository}/private/contribution/{contribution_id}", tags=["private"])
    async def private_replace(
        user: BasicUser,
        session: RepoSession,
        repository: str,
        contribution_id: int,
        file: UploadFile,
    ) -> dict:
        node = _node(repository)
        contribution = await _owned(session, node, user, contribution_id)
        if contribution.is_activated:
            raise HTTPException(409, "contribution is published; deactivate it first")
        await _store_and_process(session, node, contribution, user, file)
        return {"id": contribution.id, "status": contribution.status.value}

    @app.delete(
        "/v1/{repository}/private/contribution/{contribution_id}", status_code=204, tags=["private"]
    )
    async def private_delete(
        user: BasicUser, session: RepoSession, repository: str, contribution_id: int
    ) -> None:
        node = _node(repository)
        contribution = await _owned(session, node, user, contribution_id)
        if contribution.is_activated:
            raise HTTPException(409, "cannot delete a published contribution")
        await svc.delete_contribution(session, node, contribution)

    async def _owned(session, node: NodeConfig, user, contribution_id: int) -> Contribution:
        contribution = await session.get(Contribution, contribution_id)
        if (
            contribution is None
            or contribution.node != node.node.slug
            or (contribution.contributor_id != user.id and not user.is_admin)
        ):
            raise HTTPException(404, f"contribution {contribution_id} not found")
        return contribution

    async def _store_and_process(session, node, contribution, user, file: UploadFile) -> None:
        from fiesta.db.models import ContributionStatus

        data = await file.read()
        if not data:
            raise HTTPException(422, "uploaded file is empty")
        contribution.filename = svc.default_filename(node, contribution.id)
        contribution.status = ContributionStatus.UPLOADED
        await session.commit()
        await svc.store_file(node, contribution, data)
        # Processed inline: the public API deployment has no job worker.
        await svc.process_contribution(session, node, contribution.id)
        await session.refresh(contribution)

    @app.get("/v1/{repository}/private/contributions", tags=["private"])
    async def private_list(user: BasicUser, session: RepoSession, repository: str) -> list[dict]:
        node = _node(repository)
        result = await session.execute(
            select(Contribution)
            .where(
                Contribution.contributor_id == user.id,
                Contribution.node == node.node.slug,
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

    return app


# Run with: uvicorn fiesta.apps.public:create_app --factory
