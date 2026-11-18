"""The upload page's import formats: files the node's plugins convert to its
text format (lab instrument output, say; fiesta.services.import_formats).
Listing and sniffing are public and cheap (sniffing sees each file's first
16 KB); converting is a contributor action like the upgrade (routers/upgrade):
it needs a login, the request is capped at the upload limit, and the
conversion runs in a worker thread in a temporary directory. Nothing is
stored."""

import base64
import binascii
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from fiesta.apps.deps import CurrentUser, NodeDep
from fiesta.apps.routers.upgrade import read_capped
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import ImportConversionError
from fiesta.services import import_formats
from fiesta.services.import_formats import HEAD_BYTES, UploadedFile
from fiesta.settings import get_settings

router = APIRouter(prefix="/import-formats", tags=["import"])

#: The sniff request cap: up to a thousand base64 heads.
SNIFF_LIMIT = 24 * 1024**2


class SniffFile(BaseModel):
    name: str = Field(max_length=1024)
    head: str = Field(
        "",
        max_length=(HEAD_BYTES * 4) // 3 + 8,
        description=f"The file's first {HEAD_BYTES} bytes (or fewer), base64",
    )


class SniffIn(BaseModel):
    files: list[SniffFile] = Field(max_length=1000)


class ConvertFile(BaseModel):
    name: str = Field(max_length=1024)
    data: str = Field(description="The file's bytes, base64")


class ConvertIn(BaseModel):
    files: list[ConvertFile] = Field(
        min_length=1,
        max_length=1000,
        description="The file read as this format first, then the companions it reads",
    )
    options: dict[str, Any] = Field(
        default_factory=dict,
        description="The format's options (its `options_schema`); only those the contributor set",
    )


def _decode(value: str, name: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(422, f"{name!r} is not base64") from None


def _body(model: type[BaseModel], raw: bytes):
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors(include_url=False)) from None


@router.get("")
async def list_import_formats(node: NodeDep) -> list[dict]:
    """The formats the node's plugins convert, each with its options' JSON
    schema (the import step's options form)."""
    return import_formats.describe(node)


def _sniff(node: NodeConfig, raw: bytes) -> dict:
    body = _body(SniffIn, raw)
    files = [UploadedFile(f.name, _decode(f.head, f.name)) for f in body.files]
    return {"auto_pick": import_formats.AUTO_PICK, "files": import_formats.sniff(node, files)}


@router.post(
    "/sniff",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": SniffIn.model_json_schema()}},
        }
    },
)
async def sniff_import_formats(node: NodeDep, request: Request) -> dict:
    """Per file, the format most sure of it (`confidence` 0-1; the import
    step picks it at `auto_pick` or more) and, for a file another file's
    multi-file conversion reads, that file's name (`companion_of`)."""
    raw = await read_capped(request, SNIFF_LIMIT)
    return await run_in_threadpool(_sniff, node, raw)


def _convert(node: NodeConfig, key: str, raw: bytes) -> dict:
    body = _body(ConvertIn, raw)
    files = [UploadedFile(f.name, _decode(f.data, f.name)) for f in body.files]
    limit = get_settings().max_upload_bytes
    if sum(len(f.data) for f in files) > limit:
        raise HTTPException(413, f"the files are over the {limit // 1024**2} MB upload limit")
    try:
        return import_formats.convert(node, key, files, body.options)
    except KeyError:
        raise HTTPException(404, f"no import format {key!r}") from None
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or '(options)'}: {e['msg']}" for e in exc.errors()
        )
        raise HTTPException(422, f"options: {problems}") from None
    except ImportConversionError as exc:
        warnings = [n.message for n in exc.notes if n.level in ("error", "warning")][:5]
        detail = exc.message + (" (" + "; ".join(warnings) + ")" if warnings else "")
        raise HTTPException(422, detail) from None


@router.post(
    "/{key}/convert",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": ConvertIn.model_json_schema()}},
        }
    },
)
async def convert_import_format(
    node: NodeDep, user: CurrentUser, key: str, request: Request
) -> dict:
    """The files (a `ConvertIn`) converted to the node's text format: `text`,
    rows per table, the hierarchy's counts, the converter's notes, the tool
    and options used, and `report_text` (kept with the upload). Signed-in
    users only; 413 over the upload limit; 422 when the conversion fails."""
    limit = get_settings().max_upload_bytes
    raw = await read_capped(request, (limit * 4) // 3 + 1024**2)
    return await run_in_threadpool(_convert, node, key, raw)
