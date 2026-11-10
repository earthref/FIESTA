"""Data-source sync: a node admin's script mirrors the node's source here.

In data-source mode (FIESTA_CONTRIBUTIONS_MODE, docs/data-sources.md) a node's
contributions are made at its source and a per-node script (`sources/<slug>.py`)
writes them through these routes, keeping the source's IDs, version chains and
timestamps. Each record goes through the same importer as `fiesta sync-legacy`
(`fiesta.services.legacy.import_record`) under the node's `legacy.source_id`, so
its checkpoints are shared with the bulk import and a re-sent record is a no-op.
"""

import json
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select
from starlette.datastructures import UploadFile  # what request.form() yields, not FastAPI's

from fiesta.apps.deps import CurrentUser, NodeDep, SessionDep
from fiesta.db.models import AuditEvent, LegacyImport
from fiesta.services.legacy import SourceRecord, import_record, record_fingerprint
from fiesta.services.legacy_inventory import ensure_owners

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/source", tags=["source"])

# The `record` and `owner` form fields; files are spooled to disk regardless.
_MAX_FIELD_BYTES = 8 * 1024 * 1024
# A sync script's report of one run (an audit event without a contribution).
RUN_OPERATION = "source-sync"
RUNS_SHOWN = 20


def _require_admin(node, user) -> None:
    if not user.is_node_admin(node.node.slug):
        raise HTTPException(403, "node admin only")


def _source_id(node, user) -> str:
    _require_admin(node, user)
    if node.legacy is None:
        raise HTTPException(404, f"{node.node.key} has no data source (`legacy:` block)")
    return node.legacy.source_id


def _checkpoint_filter(source_id: str):
    return LegacyImport.source_id.startswith(f"{source_id}:", autoescape=True)


async def _schedule_state(name: str) -> dict | None:
    """The ops scheduler's last run of NAME (procrastinate's job tables)."""
    from fiesta.ops.history import schedule_states

    try:
        state = (await schedule_states()).get(name)
    except Exception as exc:  # noqa: BLE001 - the page still shows the reports
        logger.warning("ops schedule state unavailable: %s", exc)
        return None
    if state is None:
        return None
    return {
        "status": state.status,
        "trigger": state.trigger,
        "deferred_at": state.deferred_at,
        "started_at": state.started_at,
        "duration": state.duration,
        "last_success_at": state.last_success_at,
    }


@router.get("")
async def get_source(session: SessionDep, node: NodeDep, user: CurrentUser) -> dict:
    """The node's data source as the admin page shows it: the mode, whether the
    checkout has its sync script, its schedule (`legacy.sync`), the scheduler's
    last run, how many records are synced and the latest run reports."""
    from fiesta.ops.config import source_schedule_name

    _require_admin(node, user)
    slug = node.node.slug
    out: dict[str, Any] = {
        "node": slug,
        "mode": node.contributions_mode,
        "source_id": node.legacy.source_id if node.legacy else None,
        "kind": node.legacy.kind if node.legacy else None,
        "script": f"sources/{slug}.py" if node.source_script else None,
        "sync": node.legacy.sync.model_dump() if node.legacy else None,
        "schedule": None,
        "synced": 0,
        "runs": [],
    }
    if node.legacy is None:
        return out
    out["synced"] = (
        await session.execute(select(func.count()).where(_checkpoint_filter(node.legacy.source_id)))
    ).scalar_one()
    name = source_schedule_name(slug)
    out["schedule"] = {"name": name, "last_run": await _schedule_state(name)}
    events = await session.execute(
        select(AuditEvent)
        .where(AuditEvent.operation == RUN_OPERATION, AuditEvent.contribution_id.is_(None))
        .order_by(AuditEvent.created_at.desc())
        .limit(RUNS_SHOWN)
    )
    out["runs"] = [{**event.details, "reported_at": event.created_at} for event in events.scalars()]
    return out


@router.get("/checkpoints")
async def get_checkpoints(session: SessionDep, node: NodeDep, user: CurrentUser) -> dict:
    """The node's mode and, per contribution ID, the fingerprint of the source
    record last applied: a sync script sends only records whose fingerprint differs."""
    source_id = _source_id(node, user)
    rows = await session.execute(
        select(LegacyImport.source_id, LegacyImport.fingerprint).where(
            _checkpoint_filter(source_id)
        )
    )
    return {
        "node": node.node.slug,
        "mode": node.contributions_mode,
        "source_id": source_id,
        "checkpoints": {key.rpartition(":")[2]: fp for key, fp in rows},
    }


class RunReport(BaseModel):
    started_at: datetime
    finished_at: datetime
    ok: bool
    trigger: str | None = None  # "cron" / "manual" under the ops worker, else by hand
    summary: dict[str, Any] = {}


@router.post("/runs", status_code=201)
async def report_run(
    session: SessionDep, node: NodeDep, user: CurrentUser, report: RunReport
) -> dict:
    """A sync script's report of one run, listed on the admin page."""
    _source_id(node, user)
    session.add(
        AuditEvent(
            contribution_id=None,
            actor_id=user.id,
            operation=RUN_OPERATION,
            details=report.model_dump(mode="json") | {"by": user.email},
        )
    )
    await session.commit()
    return {"ok": True}


@router.post("/run", status_code=202)
async def run_now(node: NodeDep, user: CurrentUser) -> dict:
    """Queue the node's source schedule on the ops worker now (it runs under the
    schedule's lock and reports like a scheduled run)."""
    from procrastinate.exceptions import AlreadyEnqueued

    from fiesta.ops.app import build_ops_app
    from fiesta.ops.config import Schedule, get_ops_config, source_schedule_name
    from fiesta.ops.history import RUN_TASK

    _source_id(node, user)
    if node.source_script is None:
        raise HTTPException(409, f"no sources/{node.node.slug}.py in this checkout")
    if node.contributions_mode != "source":
        raise HTTPException(409, f"{node.node.key} is in public mode; its source is not synced")
    name = source_schedule_name(node.node.slug)
    lock = Schedule.model_construct(name=name, lock=None).lock_key
    app = build_ops_app(get_ops_config(), periodic=False)
    try:
        async with app.open_async():
            job_id = (
                await app.tasks[RUN_TASK]
                .configure(lock=lock, queueing_lock=lock)
                .defer_async(name=name, trigger=f"manual ({user.email})")
            )
    except AlreadyEnqueued:
        raise HTTPException(409, "a run is already waiting for the ops worker") from None
    return {"job_id": job_id, "schedule": name}


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
