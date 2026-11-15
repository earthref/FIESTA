"""Upgrading contribution text written against an older data-model version
(the upload page's import step and the Upgrade page; legacy MagIC
upgrade_contribution.jsx). Stateless and public, like the legacy tool, which
ran in the browser: nothing is stored."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from fiesta.apps.deps import NodeDep
from fiesta.domain.parse import ParseError, parse_text
from fiesta.domain.upgrade import UpgradeOptions
from fiesta.services.upgrades import detect, upgrade_parsed, upgraded_text

router = APIRouter(tags=["upgrade"])


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


@router.post("/upgrade")
async def upgrade_text(node: NodeDep, body: UpgradeIn) -> dict:
    """The text upgraded to the node's latest data model with a report of what
    was renamed, merged, dropped or filled, or `upgraded: false` when it is
    already written in the latest version (or in none the node knows)."""
    try:
        parsed = parse_text(body.text)
    except ParseError as exc:
        raise HTTPException(422, f"the contribution cannot be read: {exc}") from None
    version, guessed = detect(node, parsed)
    options = UpgradeOptions(body.unknown_columns, body.renames, body.defaults)
    result = await run_in_threadpool(upgrade_parsed, node, parsed, options)
    latest = node.data_model.latest
    if result is None:
        return {
            "upgraded": False,
            "from_version": version,
            "to_version": latest,
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
        "text": await run_in_threadpool(upgraded_text, node, result),
        "report": result.report.as_dict(),
        "report_text": result.report.as_text(),
    }
