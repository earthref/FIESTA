"""Read-only reconciliation of a restored Postgres database and its object store."""

from sqlalchemy import select

from fiesta.db.models import Contribution, Revision, ValidationResult
from fiesta.services.revisions import digest
from fiesta.storage import Storage


async def verify_storage(session, node):
    errors = []
    checked = set()
    revisions = (await session.execute(select(Revision))).scalars().all()
    by_id = {r.id: r for r in revisions}
    for c in (await session.execute(select(Contribution))).scalars():
        for pointer in (c.head_revision, c.published_revision):
            if pointer and (pointer not in by_id or by_id[pointer].contribution_id != c.id):
                errors.append({"contribution": c.id, "error": "invalid revision pointer"})
        if c.filename and not c.head_revision:
            errors.append({"contribution": c.id, "error": "legacy file needs revision backfill"})
    storage = Storage.for_node(node)
    for revision in revisions:
        if revision.parent_id and (
            revision.parent_id not in by_id
            or by_id[revision.parent_id].contribution_id != revision.contribution_id
        ):
            errors.append({"revision": revision.id, "error": "invalid parent"})
        manifest_key = (
            f"contributions/{revision.contribution_id}/revisions/{revision.id}/manifest.json"
        )
        try:
            manifest = await storage.get_json(manifest_key)
            if manifest["snapshot"] != revision.snapshot:
                raise ValueError("manifest differs from Postgres revision")
        except Exception as exc:
            errors.append({"key": manifest_key, "error": str(exc)})
        for entry in revision.snapshot["files"].values():
            if entry["key"] in checked:
                continue
            try:
                raw = await storage.get_bytes(entry["key"])
                if digest(raw) != entry["sha256"] or len(raw) != entry["size"]:
                    raise ValueError("checksum or size mismatch")
                checked.add(entry["key"])
            except Exception as exc:
                errors.append({"key": entry["key"], "error": str(exc)})
    for report in (await session.execute(select(ValidationResult))).scalars():
        if report.artifact_key:
            try:
                artifact = await storage.get_json(report.artifact_key)
                if artifact["provenance"]["revision_id"] != report.revision_id:
                    raise ValueError("validation revision mismatch")
            except Exception as exc:
                errors.append({"key": report.artifact_key, "error": str(exc)})
    return {"revisions": len(revisions), "files": len(checked), "errors": errors}
