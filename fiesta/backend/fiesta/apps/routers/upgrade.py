"""Upgrading contribution text written against an older data-model version
(the upload page's import step and the Upgrade page; legacy MagIC
upgrade_contribution.jsx). Stateless (nothing is stored), but a contributor
action: it needs a login, the request is capped at the upload limit, and the
CPU-bound work runs in a worker thread, off the event loop."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from fiesta.apps.deps import CurrentUser, NodeDep
from fiesta.domain.parse import ParseError, parse_text
from fiesta.domain.upgrade import UpgradeOptions
from fiesta.nodeconfig import NodeConfig
from fiesta.services.upgrades import detect, upgrade_parsed, upgraded_text
from fiesta.settings import get_settings

router = APIRouter(tags=["upgrade"])


async def read_capped(request: Request, limit: int) -> bytes:
    """The request body, refused with a 413 as soon as it is over `limit`
    bytes: by its declared length before anything is read, else while it
    streams in (a chunked body)."""
    message = f"the request is over the {limit // 1024**2} MB upload limit"
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise HTTPException(413, message)
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, message)
        chunks.append(chunk)
    return b"".join(chunks)


class UpgradeIn(BaseModel):
    text: str = Field(description="Contribution text (the node's tab-delimited format)")
    unknown_columns: Literal["keep", "drop"] = Field(
        "keep",
        description="Columns and tables the old model does not define: kept under their own "
        "name (to map or skip in the import step) or dropped",
    )
    renames: dict[str, str] = Field(
        default_factory=dict,
        max_length=5000,
        description='"table.column" -> new column name, applied before upgrading ("" drops it)',
    )
    defaults: dict[str, bool] = Field(
        default_factory=dict,
        max_length=100,
        description="Blank defaults (report.defaults[].key) switched on or off",
    )


def _upgrade(node: NodeConfig, raw: bytes) -> dict:
    """The whole conversion (read the JSON, parse, detect, upgrade, write):
    synchronous and CPU-bound, so the route runs it in a thread."""
    try:
        body = UpgradeIn.model_validate_json(raw)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors(include_url=False)) from None
    try:
        parsed = parse_text(body.text)
    except ParseError as exc:
        raise HTTPException(422, f"the contribution cannot be read: {exc}") from None
    version, guessed = detect(node, parsed)
    options = UpgradeOptions(body.unknown_columns, body.renames, body.defaults)
    result = upgrade_parsed(node, parsed, options)
    if result is None:
        return {
            "upgraded": False,
            "from_version": version,
            "to_version": node.data_model.latest,
            "guessed": guessed,
            "text": None,
            "report": None,
            "report_text": None,
        }
    return {
        "upgraded": True,
        "from_version": result.report.from_version,
        "to_version": result.report.to_version,
        "guessed": result.report.guessed,
        "text": upgraded_text(node, result),
        "report": result.report.as_dict(),
        "report_text": result.report.as_text(),
    }


@router.post(
    "/upgrade",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": UpgradeIn.model_json_schema()}},
        }
    },
)
async def upgrade_text(node: NodeDep, user: CurrentUser, request: Request) -> dict:
    """The text (an `UpgradeIn`) upgraded to the node's latest data model with
    a report of what was renamed, merged, dropped or filled, or `upgraded:
    false` when it is already written in the latest version (or in none the
    node knows). Signed-in users only; 413 over the upload limit."""
    raw = await read_capped(request, get_settings().max_upload_bytes)
    return await run_in_threadpool(_upgrade, node, raw)
