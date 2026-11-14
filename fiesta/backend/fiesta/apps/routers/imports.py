"""The upload page's import settings templates, per user and node (legacy
MagIC data_importer.jsx create/load/save/rename/delete)."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from fiesta.apps.deps import CurrentUser, NodeDep, SessionDep
from fiesta.db.models import ImportTemplate

router = APIRouter(prefix="/private/import-templates", tags=["private"])


class ImportSettings(BaseModel):
    """One sheet's import settings. `column_map` maps an input column header
    to a data-model column (null: not mapped); `n_header_rows` is "" for a
    sheet without a header row, as in the legacy importer."""

    table_name: str = Field("", max_length=255)
    n_header_rows: str = Field("1", max_length=8)
    column_map: dict[str, str | None] = Field(default_factory=dict, max_length=5000)
    exclude_column_names: list[str] = Field(default_factory=list, max_length=5000)
    exclude_table: bool = False


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    settings: ImportSettings


class TemplatePatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    settings: ImportSettings | None = None


def _out(t: ImportTemplate) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "settings": t.settings,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    }


async def _own(session, node, user, template_id: int) -> ImportTemplate:
    t = await session.get(ImportTemplate, template_id)
    if t is None or t.user_id != user.id or t.node != node.node.slug:
        raise HTTPException(404, f"import template {template_id} not found")
    return t


async def _commit(session) -> None:
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "you already have an import template with that name") from None


@router.get("")
async def list_templates(session: SessionDep, node: NodeDep, user: CurrentUser) -> list[dict]:
    rows = await session.execute(
        select(ImportTemplate)
        .where(ImportTemplate.user_id == user.id, ImportTemplate.node == node.node.slug)
        .order_by(ImportTemplate.name)
    )
    return [_out(t) for t in rows.scalars()]


@router.post("", status_code=201)
async def create_template(
    payload: TemplateIn, session: SessionDep, node: NodeDep, user: CurrentUser
) -> dict:
    t = ImportTemplate(
        user_id=user.id,
        node=node.node.slug,
        name=payload.name.strip(),
        settings=payload.settings.model_dump(),
    )
    session.add(t)
    await _commit(session)
    return _out(t)


@router.put("/{template_id}")
async def update_template(
    template_id: int, payload: TemplatePatch, session: SessionDep, node: NodeDep, user: CurrentUser
) -> dict:
    """Save new settings into a template, rename it, or both."""
    t = await _own(session, node, user, template_id)
    if payload.name is not None:
        t.name = payload.name.strip()
    if payload.settings is not None:
        t.settings = payload.settings.model_dump()
    await _commit(session)
    return _out(t)


@router.delete("/{template_id}", status_code=204)
async def delete_template(
    template_id: int, session: SessionDep, node: NodeDep, user: CurrentUser
) -> None:
    await session.delete(await _own(session, node, user, template_id))
    await session.commit()
