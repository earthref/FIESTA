"""Saving an upload page import: the browser's converted tables, merged into
the contribution through the revision service (legacy MagIC
upload_contribution.jsx `reviewUpload` + `upload`)."""

from fastapi import HTTPException

from fiesta.db.models import Contribution
from fiesta.domain.importer import merge, normalise, single_source_errors
from fiesta.domain.parse import (
    ParsedContribution,
    ParseError,
    block_tables,
    export_text,
    parse_text,
)
from fiesta.domain.validate import Validator
from fiesta.nodeconfig import NodeConfig
from fiesta.services.contributions import default_filename
from fiesta.services.revisions import revision_file, safe_name, save_revision


async def _current_tables(session, node, contribution, expected_revision) -> ParsedContribution:
    """The tables of the revision the upload was prepared against (the save
    then refuses it if that is no longer the head)."""
    if not expected_revision:
        return ParsedContribution()
    raw = await revision_file(session, node, contribution, revision_id=expected_revision)
    try:
        return parse_text(raw.decode("utf-8"))
    except (ParseError, UnicodeDecodeError) as exc:
        raise HTTPException(
            422,
            "the contribution's current text cannot be read, so the upload cannot "
            f"replace some of its tables ({exc}); correct it first or upload into "
            "a new contribution",
        ) from None


def original_names(originals: dict[str, bytes], canonical: str) -> dict[str, bytes]:
    """The uploaded files, kept beside the canonical text as attachments of
    the revision (an original named like the canonical file is prefixed)."""
    kept = {}
    for name, data in originals.items():
        name = safe_name(name)
        kept[f"original-{name}" if name == canonical else name] = data
    return kept


async def save_import(
    session,
    node: NodeConfig,
    contribution: Contribution,
    actor_id: int,
    *,
    text: str,
    originals: dict[str, bytes],
    expected_revision: str | None,
    request_key: str,
):
    try:
        imported = parse_text(text)
    except ParseError as exc:
        raise HTTPException(422, f"the imported tables cannot be read: {exc}") from None
    if not any(imported.tables.values()):
        raise HTTPException(422, "there are no rows to import")
    if errors := single_source_errors(block_tables(text), node.upload.single_source_tables):
        raise HTTPException(422, " ".join(errors))
    version = node.data_model.latest
    model = node.load_data_model(version)
    imported = normalise(imported, model, Validator(node, version).vocabulary_terms)
    current = await _current_tables(session, node, contribution, expected_revision)
    workspace = model["tables"].get(node.workspace.table, {}).get("columns", {})
    keep = [f.column for f in node.workspace.fields]
    if "reference" in workspace:
        keep.append("reference")
    merged = merge(current, imported, keep_table=node.workspace.table, keep_columns=keep)
    canonical = contribution.filename or default_filename(node, contribution.id)
    files = {**original_names(originals, canonical), canonical: export_text(merged, model).encode()}
    return await save_revision(
        session,
        node,
        contribution,
        actor_id,
        expected_revision=expected_revision,
        request_key=request_key,
        files=files,
        canonical=canonical,
        operation="import",
    )
