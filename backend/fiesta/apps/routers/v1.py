"""The legacy api.earthref.org contract, served unchanged at /v1.

Ported from old-backend/v1 (Koa + openapi-backend over OpenSearch) onto
FIESTA's Postgres-owned contributions, revision service and search
projection. The surface is frozen: the same paths, query parameters,
Accept negotiation, HTTP Basic auth and `{"errors": [{"message": ...}]}`
error bodies as `fiesta/apps/v1_openapi.yaml` (the published
old-backend/public/v1/openapi.yaml, served at /v1/openapi.yaml). New
behaviour goes into /v2; the deliberate differences from the legacy code
are listed under "Legacy v1" in docs/api.md.
"""

import asyncio
import io
import json
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.docs import get_redoc_html
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from opensearchpy.exceptions import NotFoundError, OpenSearchException
from sqlalchemy import func, select
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.routing import get_route_path

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.db.models import Contribution, User
from fiesta.domain.parse import ParsedContribution, ParseError, export_text, parse_text
from fiesta.domain.validate import (
    ValidationReport,
    guess_data_model_version,
    validate_contribution,
)
from fiesta.nodeconfig import NodeConfig
from fiesta.search.client import get_opensearch
from fiesta.security import verify_password
from fiesta.services import contributions as svc
from fiesta.services.access import can_access
from fiesta.services.revisions import locked, revision_file, save_revision, snapshot_for
from fiesta.storage import Storage, file_key

OPENAPI_YAML = Path(__file__).resolve().parent.parent / "v1_openapi.yaml"
NOT_RECOGNIZED = "Username or password is not recognized."
NOT_DEFINED = (
    "Path '{path}' is not defined for this API. See https://api.earthref.org for more information."
)
# Legacy table aliases. `experiments` was the legacy measurement search level;
# FIESTA indexes measurement rows under `measurements`.
TABLE_ALIASES = {"contributions": "contribution", "experiments": "measurements"}
ID_CHUNK = 60000

router = APIRouter(include_in_schema=False)
basic_scheme = HTTPBasic(auto_error=False)


# ---- legacy error bodies -------------------------------------------------------


def errors(status: int, *messages: str) -> JSONResponse:
    return JSONResponse({"errors": [{"message": m} for m in messages]}, status_code=status)


def _is_v1(request: Request) -> bool:
    path = get_route_path(request.scope)
    return path == "/v1" or path.startswith("/v1/")


def install(app: FastAPI) -> None:
    """Give /v1 the Koa error shapes (notFound for an unknown path or method,
    validationFail as 400) while /v2 keeps FastAPI's `detail` bodies."""

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):
        if not _is_v1(request):
            return await http_exception_handler(request, exc)
        if exc.status_code in (404, 405) and exc.detail in ("Not Found", "Method Not Allowed"):
            return errors(404, NOT_DEFINED.format(path=get_route_path(request.scope)))
        detail = exc.detail if isinstance(exc.detail, str) else json.dumps(exc.detail)
        return errors(exc.status_code, detail)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        if not _is_v1(request):
            return await request_validation_exception_handler(request, exc)
        return JSONResponse(
            {
                "errors": [
                    {"message": e["msg"], "path": [str(p) for p in e["loc"]]} for e in exc.errors()
                ]
            },
            status_code=400,
        )


# ---- auth ------------------------------------------------------------------------


async def _throttle() -> None:
    await asyncio.sleep(0.5)  # the legacy API slowed failed logins down


async def legacy_user(
    session: SessionDep,
    credentials: Annotated[HTTPBasicCredentials | None, Depends(basic_scheme)],
) -> User | None:
    """HTTP Basic with an EarthRef handle (legacy) or email + password; None
    when missing or wrong so each route can answer with its legacy body."""
    if credentials is None:
        return None
    username = credentials.username.strip().lower()
    user = (
        await session.execute(
            select(User).where(
                (func.lower(User.email) == username) | (func.lower(User.handle) == username)
            )
        )
    ).scalar_one_or_none()
    if user is None or not verify_password(credentials.password, user.password_hash):
        await _throttle()
        return None
    return user


LegacyUser = Annotated[User | None, Depends(legacy_user)]


def _user_record(user: User) -> dict:
    parts = (user.name or "").split()
    given, family = (" ".join(parts[:-1]), parts[-1]) if len(parts) > 1 else (user.name or "", "")
    return {
        "id": user.id,
        "handle": user.handle,
        "name": {"given": given, "family": family},
        "email": user.email,
        "orcid": user.orcid,
        "has_password": True,
    }


# ---- content negotiation and contribution text ----------------------------------


def accept_format(request: Request) -> str:
    """Koa's `ctx.accepts('text/plain') ? 'txt' : 'json'`: MagIC text unless
    the Accept header names only other types (`application/json`)."""
    accept = request.headers.get("accept", "")
    if not accept.strip():
        return "txt"
    offered = {part.split(";")[0].strip().lower() for part in accept.split(",")}
    if offered & {"text/plain", "text/*", "*/*", "application/vnd.ms-excel"}:
        return "txt"
    return "json"


async def contribution_text(session, node: NodeConfig, contribution: Contribution) -> str | None:
    """The canonical file of the head revision (or the pre-revision file);
    None when the contribution has no content yet."""
    if contribution.head_revision:
        try:
            raw = await revision_file(session, node, contribution)
        except HTTPException:
            return None
    elif contribution.filename:
        raw = await Storage.for_node(node).get_bytes(
            file_key(contribution.id, contribution.filename)
        )
    else:
        return None
    return raw.decode("utf-8", errors="replace")


def _tables(text: str) -> dict[str, list[dict[str, str]]]:
    try:
        return parse_text(text).tables
    except ParseError as exc:
        raise HTTPException(500, f"stored contribution is not parseable: {exc}") from None


def _data_response(text: str, fmt: str) -> Response:
    if fmt == "json":
        return JSONResponse(_tables(text))
    return PlainTextResponse(text)


def _export(node: NodeConfig, tables: dict[str, list[dict[str, str]]]) -> str:
    parsed = ParsedContribution(tables=tables)
    model = node.load_data_model(guess_data_model_version(node, parsed))
    return export_text(parsed, model)


def legacy_validation(report: ValidationReport) -> dict:
    """`{errors, warnings}` of `{table, column, message, rows}` as
    validate_contribution.js reported them (one entry per message, rows grouped)."""

    def group(issues) -> list[dict]:
        grouped: dict[tuple, list[int]] = {}
        for issue in issues:
            rows = grouped.setdefault((issue.table, issue.column, issue.message), [])
            if issue.row is not None:
                rows.append(issue.row)
        return [
            {"table": table, "column": column, "message": message, "rows": rows}
            for (table, column, message), rows in grouped.items()
        ]

    return {"errors": group(report.errors), "warnings": group(report.warnings)}


def _validate_texts(node: NodeConfig, texts: list[str]) -> dict:
    validation: dict = {"errors": [], "warnings": []}
    for text in texts:
        try:
            parsed = parse_text(text)
        except ParseError as exc:
            validation["errors"].append(
                {"table": None, "column": None, "message": exc.message, "rows": [exc.line]}
            )
            continue
        report = validate_contribution(node, parsed, guess_data_model_version(node, parsed))
        for key, issues in legacy_validation(report).items():
            validation[key].extend(issues)
    return validation


# ---- Postgres visibility -----------------------------------------------------------


async def _lineage(session, node: NodeConfig, ids: list[int]) -> set[int]:
    """Every version in the history of each id (the legacy `_history.id` match)."""
    seen: set[int] = set()
    frontier = set(ids)
    while frontier:
        seen |= frontier
        rows = (
            await session.execute(
                select(Contribution).where(
                    Contribution.node == node.node.slug,
                    Contribution.id.in_(frontier) | Contribution.previous_id.in_(frontier),
                )
            )
        ).scalars()
        frontier = {i for c in rows for i in (c.id, c.previous_id) if i is not None} - seen
    return seen


async def public_contributions(
    session,
    node: NodeConfig,
    *,
    only_latest: bool = False,
    ids: list[int] | None = None,
    dois: list[str] | None = None,
) -> list[Contribution]:
    """Published contributions, newest first. Unlike /v2, superseded
    versions stay visible (legacy public search never filtered `_is_latest`)."""
    stmt = select(Contribution).where(
        Contribution.node == node.node.slug,
        Contribution.deleted_at.is_(None),
        Contribution.is_activated.is_(True),
    )
    if only_latest:
        stmt = stmt.where(Contribution.is_latest.is_(True))
    if dois:
        stmt = stmt.where(func.upper(Contribution.reference_doi).in_([d.upper() for d in dois]))
    stmt = stmt.order_by(Contribution.activated_at.desc().nulls_last(), Contribution.id.desc())
    rows = list((await session.execute(stmt)).scalars())
    if ids is not None:
        lineage = await _lineage(session, node, ids)
        rows = [c for c in rows if c.id in lineage]
    return rows


async def private_contributions(
    session,
    node: NodeConfig,
    user: User,
    *,
    ids: list[int] | None = None,
    dois: list[str] | None = None,
) -> list[Contribution]:
    """The caller's unpublished contributions (own, or shared through a
    workspace), newest first."""
    stmt = select(Contribution).where(
        Contribution.node == node.node.slug,
        Contribution.deleted_at.is_(None),
        Contribution.is_activated.is_(False),
    )
    if ids is not None:
        stmt = stmt.where(Contribution.id.in_(ids))
    if dois:
        stmt = stmt.where(func.upper(Contribution.reference_doi).in_([d.upper() for d in dois]))
    stmt = stmt.order_by(Contribution.updated_at.desc(), Contribution.id.desc())
    rows = (await session.execute(stmt)).scalars()
    return [c for c in rows if await can_access(session, c, user)]


async def _owned(session, node: NodeConfig, user: User, contribution_id: int, *, write=False):
    """(contribution, accessible) — the contribution when it exists in this
    node, plus whether the caller may use it."""
    c = await session.get(Contribution, contribution_id)
    if c is None or c.deleted_at is not None or c.node != node.node.slug:
        return None, False
    return c, await can_access(session, c, user, write=write)


# ---- OpenSearch --------------------------------------------------------------------


def _ids_filter(ids) -> dict:
    ordered = sorted(ids)
    groups = [
        {"terms": {"summary.contribution.id": ordered[i : i + ID_CHUNK]}}
        for i in range(0, len(ordered), ID_CHUNK)
    ]
    return {"bool": {"should": groups, "minimum_should_match": 1}} if groups else {"match_none": {}}


def search_body(
    *,
    table: str,
    size: int,
    from_: int,
    queries: list[str],
    ids,
    exists: list[str] = (),
    not_exists: list[str] = (),
    and_operator: bool = True,
    must_extra: list[dict] = (),
) -> dict:
    """The legacy query: `query_string` per `query` value, `exists` per column,
    newest first, `summary.contribution` + `rows` only — plus the Postgres
    visibility filter (`ids`) that /v2 applies too."""
    must: list[dict] = [{"term": {"type": table}}]
    for query in queries:
        clause: dict = {"query": query}
        if and_operator:
            clause["default_operator"] = "AND"
        must.append({"query_string": clause})
    must += [{"exists": {"field": f"summary._all.{column}"}} for column in exists]
    must += list(must_extra)
    must_not = [{"exists": {"field": f"summary._all.{column}"}} for column in not_exists]
    return {
        "size": size,
        "from": from_,
        "_source": ["summary.contribution", "rows"],
        "sort": [{"summary.contribution.timestamp": {"order": "desc", "unmapped_type": "date"}}],
        "query": {"bool": {"must": must, "must_not": must_not, "filter": [_ids_filter(ids)]}},
    }


async def run_search(node: NodeConfig, body: dict) -> tuple[int, list[dict]]:
    try:
        response = await get_opensearch().search(index=node.search_index, body=body)
    except NotFoundError:
        return 0, []
    except OpenSearchException as exc:  # e.g. an unparsable query_string
        raise HTTPException(500, str(exc)) from None
    hits = response["hits"]
    total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]
    return total, hits["hits"]


def shape_results(hits: list[dict], table: str) -> list:
    """Contribution rows are `summary.contribution` without the workflow
    (`_`-prefixed) fields; every other table is the flattened `rows`."""
    if table == "contribution":
        return [
            {
                k: v
                for k, v in h["_source"].get("summary", {}).get("contribution", {}).items()
                if not k.startswith("_")
            }
            for h in hits
        ]
    return [row for h in hits for row in h["_source"].get("rows", [])]


async def _search_page(
    node: NodeConfig,
    *,
    table: str,
    size: int,
    from_: int,
    queries: list[str],
    ids,
    exists: list[str] = (),
    not_exists: list[str] = (),
    and_operator: bool = True,
    extra: dict | None = None,
) -> Response:
    table = TABLE_ALIASES.get(table, table)
    total, hits = await run_search(
        node,
        search_body(
            table=table,
            size=size,
            from_=from_,
            queries=queries,
            ids=ids,
            exists=exists,
            not_exists=not_exists,
            and_operator=and_operator,
        ),
    )
    if total <= 0:
        return Response(status_code=204)
    return JSONResponse(
        {
            "total": total,
            "table": table,
            "size": size,
            "from": from_,
            "queries": queries,
            **(extra or {}),
            "results": shape_results(hits, table),
        }
    )


# ---- zip archives ------------------------------------------------------------------


def _stamp() -> str:
    iso = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return iso.replace("-", "").replace(":", "")


async def archive(
    session,
    node: NodeConfig,
    contributions: list[Contribution],
    *,
    label: str,
    formats: tuple[str, ...],
) -> Response:
    buffer = io.BytesIO()
    added = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for c in contributions:
            text = await contribution_text(session, node, c)
            if text is None:
                continue
            stem = f"{c.id}/{node.node.slug}_contribution_{c.id}"
            if "txt" in formats:
                zf.writestr(stem + ".txt", text)
            if "json" in formats:
                zf.writestr(stem + ".json", json.dumps(_tables(text), indent=2))
            added += 1
    if not added:
        ids = ", ".join(str(c.id) for c in contributions)
        return errors(500, f"Failed to retrieve contributions [{ids}] for download.")
    name = f"{node.node.key} Download - {label} - {_stamp()}.zip"
    return Response(
        buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


# ---- documentation and root ----------------------------------------------------------


@router.get("/")
@router.get("/index.html")
async def root(request: Request) -> RedirectResponse:
    return RedirectResponse(request.scope.get("root_path", "") + "/v1")


@router.get("/v1")
@router.get("/v1/")
@router.get("/v1/index.html")
async def docs(request: Request):
    return get_redoc_html(
        openapi_url=request.scope.get("root_path", "") + "/v1/openapi.yaml",
        title="EarthRef.org FIESTA API",
    )


@router.get("/openapi.yaml")
@router.get("/v1/openapi.yaml")
async def openapi_yaml() -> PlainTextResponse:
    return PlainTextResponse(OPENAPI_YAML.read_text(), media_type="text/plain; charset=utf-8")


# ---- system and people -----------------------------------------------------------------


@router.get("/v1/health-check")
async def health_check():
    # As esCheckConnection did: the cluster answers and is yellow or green.
    try:
        health = await get_opensearch().cluster.health()
        healthy = health.get("status") in ("yellow", "green")
    except Exception:  # any failure is an unhealthy answer
        healthy = False
    if healthy:
        return {"message": "Healthy!"}
    return errors(500, "Health has check failed.")


@router.get("/v1/authenticate")
async def authenticate(user: LegacyUser):
    if user is None:
        return errors(401, NOT_RECOGNIZED)
    return _user_record(user)


# ---- public data -------------------------------------------------------------------------


@router.get("/v1/{repository}/download")
async def public_download(
    request: Request,
    session: SessionDep,
    node: NodeDep,
    n_max_contributions: int = Query(10, ge=1, le=100),
    only_latest: bool = False,
    query: Annotated[list[str] | None, Query()] = None,
    id: Annotated[list[int] | None, Query()] = None,
    doi: Annotated[list[str] | None, Query()] = None,
    contributor_name: Annotated[list[str] | None, Query()] = None,
    reference_title: Annotated[list[str] | None, Query()] = None,
):
    if not any((query, id, doi, contributor_name, reference_title)):
        return errors(400, "At least one query parameter is required.")
    candidates = await public_contributions(
        session, node, only_latest=only_latest, ids=id, dois=doi
    )
    if not candidates:
        return Response(status_code=204)
    if query or contributor_name or reference_title:
        must_extra: list[dict] = []
        if contributor_name:
            must_extra.append(
                {"terms": {"summary.contribution._contributor.raw": contributor_name}}
            )
        if reference_title:
            must_extra.append(
                {
                    "bool": {
                        "should": [
                            {"match_phrase": {"summary.contribution._reference.title.raw": t}}
                            for t in reference_title
                        ]
                    }
                }
            )
        body = search_body(
            table="contribution",
            size=n_max_contributions,
            from_=0,
            queries=query or [],
            ids={c.id for c in candidates},
            must_extra=must_extra,
        )
        body["_source"] = ["summary.contribution.id"]
        total, hits = await run_search(node, body)
        if total <= 0:
            return Response(status_code=204)
        by_id = {c.id: c for c in candidates}
        found = [h["_source"]["summary"]["contribution"]["id"] for h in hits]
        contributions = [by_id[i] for i in found if i in by_id]
    else:
        contributions = candidates[:n_max_contributions]
    if not contributions:
        return Response(status_code=204)
    return await archive(
        session, node, contributions, label="Public", formats=(accept_format(request),)
    )


@router.get("/v1/{repository}/data")
async def public_data(
    request: Request,
    session: SessionDep,
    node: NodeDep,
    id: Annotated[list[int] | None, Query()] = None,
    key: str | None = None,
):
    if not id and key is not None:
        return errors(
            502,
            "A contribution ID is required when requesting data from a shared "
            "contribution with a private key.",
        )
    if not id:
        return errors(
            502, "A contribution ID is required when requesting data from a public contribution."
        )
    contribution = await session.get(Contribution, id[0])
    if (
        contribution is None
        or contribution.deleted_at is not None
        or contribution.node != node.node.slug
        or not (contribution.is_activated or (key and str(contribution.private_key) == key))
    ):
        return Response(status_code=204)
    text = await contribution_text(session, node, contribution)
    if text is None:
        return Response(status_code=204)
    return _data_response(text, accept_format(request))


@router.get("/v1/{repository}/search/{table}")
async def public_search(
    session: SessionDep,
    node: NodeDep,
    table: str,
    n_max_rows: int | None = Query(None, ge=1, le=10000),
    from_: int | None = Query(None, ge=0, alias="from"),
    query: Annotated[list[str] | None, Query()] = None,
    included_columns: Annotated[list[str] | None, Query()] = None,
    missing_columns: Annotated[list[str] | None, Query()] = None,
):
    ids = {c.id for c in await public_contributions(session, node)}
    return await _search_page(
        node,
        table=table,
        size=n_max_rows or 10,
        from_=from_ or 0,
        queries=query or [],
        ids=ids,
        exists=included_columns or [],
        not_exists=missing_columns or [],
    )


@router.post("/v1/{repository}/validate")
async def public_validate(
    request: Request, node: NodeDep, file: Annotated[list[UploadFile] | None, File()] = None
):
    if file:
        texts = [(await f.read()).decode("utf-8", errors="replace") for f in file]
    else:
        texts = [(await request.body()).decode("utf-8", errors="replace")]
    return {"validation": _validate_texts(node, texts)}


# ---- private data ------------------------------------------------------------------------


@router.get("/v1/{repository}/private/download")
async def private_download(
    session: SessionDep,
    node: NodeDep,
    user: LegacyUser,
    n_max_contributions: int = Query(10, ge=1, le=100),
    query: Annotated[list[str] | None, Query()] = None,
    id: Annotated[list[int] | None, Query()] = None,
    doi: Annotated[list[str] | None, Query()] = None,
):
    if user is None:
        return errors(401, "Username or password is not recognized")
    if not any((query, id, doi)):
        return errors(400, "At least one query parameter is required")
    candidates = await private_contributions(session, node, user, ids=id, dois=doi)
    if candidates and query:
        body = search_body(
            table="contribution",
            size=n_max_contributions,
            from_=0,
            queries=query,
            ids={c.id for c in candidates},
            and_operator=False,
        )
        body["_source"] = ["summary.contribution.id"]
        _, hits = await run_search(node, body)
        by_id = {c.id: c for c in candidates}
        found = [h["_source"]["summary"]["contribution"]["id"] for h in hits]
        candidates = [by_id[i] for i in found if i in by_id]
    contributions = candidates[:n_max_contributions]
    if not contributions:
        return Response(status_code=204)
    return await archive(session, node, contributions, label="Private", formats=("txt", "json"))


@router.get("/v1/{repository}/private/data")
async def private_data(
    request: Request,
    session: SessionDep,
    node: NodeDep,
    user: LegacyUser,
    id: int = Query(..., ge=1),
):
    if user is None:
        return errors(401, "Username or password is not recognized")
    contribution, accessible = await _owned(session, node, user, id)
    if contribution is None or not accessible or contribution.is_activated:
        return Response(status_code=204)
    text = await contribution_text(session, node, contribution)
    if text is None:
        return Response(status_code=204)
    return _data_response(text, accept_format(request))


@router.put("/v1/{repository}/private/validate")
async def private_validate(
    session: SessionDep, node: NodeDep, user: LegacyUser, id: int = Query(..., ge=1)
):
    if user is None:
        return errors(401, "Username or password is not recognized")
    contribution, accessible = await _owned(session, node, user, id)
    if contribution is None or not accessible or contribution.is_activated:
        return Response(status_code=204)
    text = await contribution_text(session, node, contribution)
    if text is None:
        return Response(status_code=204)
    return {"validation": _validate_texts(node, [text])}


@router.get("/v1/{repository}/private/search/{table}")
async def private_search(
    session: SessionDep,
    node: NodeDep,
    user: LegacyUser,
    table: str,
    n_max_rows: int | None = Query(None, ge=1, le=10000),
    from_: int | None = Query(None, ge=0, alias="from"),
    query: Annotated[list[str] | None, Query()] = None,
):
    if user is None:
        return errors(401, NOT_RECOGNIZED)
    ids = {c.id for c in await private_contributions(session, node, user)}
    return await _search_page(
        node,
        table=table,
        size=n_max_rows or 10,
        from_=from_ or 0,
        queries=query or [],
        ids=ids,
        and_operator=False,
        extra={"exists_fields": [], "not_exists_fields": []},
    )


@router.post("/v1/{repository}/private")
async def private_create(session: SessionDep, node: NodeDep, user: LegacyUser):
    if user is None:
        return errors(401, NOT_RECOGNIZED)
    contribution = Contribution(
        node=node.node.slug, contributor_id=user.id, data_model_version=node.data_model.latest
    )
    session.add(contribution)
    await session.commit()
    return JSONResponse({"id": contribution.id}, status_code=201)


async def _next_version(session, node: NodeConfig, user: User, original: Contribution):
    """A published contribution is immutable: the upload lands on its next
    version (previous_id → original), which is what the legacy API's "new
    private contribution" became. Returns the draft and its inherited
    attachments (the caller saves them with the new canonical file)."""
    original = await locked(session, original.id)
    if not original.published_revision:
        raise HTTPException(409, "only a published contribution starts a new version")
    draft = Contribution(
        node=node.node.slug,
        contributor_id=user.id,
        version=original.version + 1,
        previous_id=original.id,
        data_model_version=original.data_model_version,
        reference_doi=original.reference_doi,
        workspace_id=original.workspace_id,
    )
    session.add(draft)
    await session.flush()
    snapshot = await snapshot_for(session, original)
    attachments = {
        name: await revision_file(session, node, original, name)
        for name in snapshot["files"]
        if name != snapshot["canonical"]
    }
    return draft, attachments


async def _ingest(
    session, node: NodeConfig, user: User | None, contribution_id: int, files, *, append: bool
):
    if user is None:
        return errors(401, NOT_RECOGNIZED)
    if not files:
        return errors(400, "At least one file is required.")
    contribution, accessible = await _owned(session, node, user, contribution_id, write=True)
    if contribution is None:
        return Response(status_code=204)
    if not accessible:
        return errors(
            401, f"The contribution with ID {contribution.id} is owned by another contributor."
        )
    previous_text = await contribution_text(session, node, contribution)
    previous = _tables(previous_text) if previous_text else {}
    merged = {table: list(rows) for table, rows in previous.items()}
    rows_added = 0
    for upload in files:
        text = (await upload.read()).decode("utf-8", errors="replace")
        try:
            parsed = parse_text(text)
        except ParseError as exc:
            return errors(500, f"{upload.filename or 'file'}: {exc}")
        for table, rows in parsed.tables.items():
            if append:
                merged.setdefault(table, []).extend(rows)
                rows_added += len(rows)
            else:
                merged[table] = list(rows)
    if "contribution" in previous:
        merged["contribution"] = previous["contribution"]  # the contribution row stays

    target, inherited = contribution, {}
    if contribution.is_activated:
        target, inherited = await _next_version(session, node, user, contribution)
    name = target.filename or svc.default_filename(node, target.id)
    await save_revision(
        session,
        node,
        target,
        user.id,
        expected_revision=target.head_revision,
        request_key=str(uuid.uuid4()),
        files={**inherited, name: _export(node, merged).encode()},
        canonical=name,
        operation="legacy-append" if append else "legacy-replace",
    )
    await session.commit()
    body = {"id": target.id, "rows_added": rows_added} if append else {"id": target.id}
    return JSONResponse(body, status_code=202)


@router.put("/v1/{repository}/private")
async def private_update(
    session: SessionDep,
    node: NodeDep,
    user: LegacyUser,
    id: int = Query(..., ge=1),
    file: Annotated[list[UploadFile] | None, File()] = None,
):
    return await _ingest(session, node, user, id, file, append=False)


@router.patch("/v1/{repository}/private")
async def private_append(
    session: SessionDep,
    node: NodeDep,
    user: LegacyUser,
    id: int = Query(..., ge=1),
    file: Annotated[list[UploadFile] | None, File()] = None,
):
    return await _ingest(session, node, user, id, file, append=True)


@router.delete("/v1/{repository}/private")
async def private_delete(
    session: SessionDep, node: NodeDep, user: LegacyUser, id: int = Query(..., ge=1)
):
    if user is None:
        return errors(401, NOT_RECOGNIZED)
    contribution, accessible = await _owned(session, node, user, id, write=True)
    if contribution is None or not accessible:
        return {"rowsDeleted": 0}
    await svc.delete_contribution(session, node, contribution, actor_id=user.id)
    return {"rowsDeleted": 1}
