"""Data-source sync: a node admin's script mirrors the node's source here.

In data-source mode (FIESTA_CONTRIBUTIONS_MODE, docs/data-sources.md) a node's
contributions are made at its source and a per-node script (`sources/<slug>.py`)
writes them through these routes, keeping the source's IDs, version chains and
timestamps. Each record goes through the same importer as `fiesta sync-legacy`
(`fiesta.services.legacy.import_record`) under the node's `legacy.source_id`, so
its checkpoints are shared with the bulk import and a re-sent record is a no-op.
"""

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy import select
from starlette.datastructures import UploadFile  # what request.form() yields, not FastAPI's

from fiesta.apps.deps import CurrentUser, NodeDep, SessionDep
from fiesta.db.models import LegacyImport
from fiesta.services.legacy import SourceRecord, import_record, record_fingerprint
from fiesta.services.legacy_inventory import ensure_owners

router = APIRouter(prefix="/source", tags=["source"])

# The `record` and `owner` form fields; files are spooled to disk regardless.
_MAX_FIELD_BYTES = 8 * 1024 * 1024


def _source_id(node, user) -> str:
    if not user.is_node_admin(node.node.slug):
        raise HTTPException(403, "node admin only")
    if node.legacy is None:
        raise HTTPException(404, f"{node.node.key} has no data source (`legacy:` block)")
    return node.legacy.source_id


@router.get("")
async def get_source(session: SessionDep, node: NodeDep, user: CurrentUser) -> dict:
    """The node's mode and, per contribution ID, the fingerprint of the source
    record last applied: a sync script sends only records whose fingerprint differs."""
    source_id = _source_id(node, user)
    rows = await session.execute(
        select(LegacyImport.source_id, LegacyImport.fingerprint).where(
            LegacyImport.source_id.startswith(f"{source_id}:", autoescape=True)
        )
    )
    return {
        "node": node.node.slug,
        "mode": node.contributions_mode,
        "source_id": source_id,
        "checkpoints": {key.rpartition(":")[2]: fp for key, fp in rows},
    }


@router.put("/records/{contribution_id}")
async def put_record(
    request: Request, node: NodeDep, user: CurrentUser, contribution_id: int
) -> dict:
    """Apply one source record (multipart): `record` is a SourceRecord as JSON,
    `owner` optionally the owner's account fields (email, name, handle, orcid;
    a missing account is created without a password), and each file of each
    revision is a part named `<revision key>/<file name>`."""
    source_id = _source_id(node, user)
    if node.contributions_mode != "source":
        raise HTTPException(409, f"{node.node.key} is in public mode; its source is not synced")
    form = await request.form(max_part_size=_MAX_FIELD_BYTES)
    try:
        record = SourceRecord.model_validate_json(form.get("record") or "")
    except ValidationError as exc:
        raise HTTPException(422, f"record: {exc}") from None
    if record.id != contribution_id:
        raise HTTPException(422, "record id does not match the URL")
    owner = json.loads(form.get("owner") or "null")
    if owner is not None:
        if str(owner.get("email", "")).lower() != record.owner_email.lower():
            raise HTTPException(422, "owner email does not match record.owner_email")
        await ensure_owners(node, [owner], apply=True)
    files = {k: v for k, v in form.multi_items() if isinstance(v, UploadFile)}

    async def load(revision, name, entry):
        part = files.get(f"{revision.key}/{name}")
        if part is None:
            raise ValueError(f"file part {revision.key}/{name} missing")
        await part.seek(0)
        return await part.read()

    try:
        status, size = await import_record(node, source_id, record, load)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    finally:
        await form.close()
    return {
        "id": record.id,
        "status": status,
        "fingerprint": record_fingerprint(record),
        "bytes": size,
    }
