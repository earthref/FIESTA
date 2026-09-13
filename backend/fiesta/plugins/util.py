"""Shared helpers for plugin API routes."""

import uuid as uuid_mod

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from fiesta.db.models import Contribution
from fiesta.domain.parse import ParsedContribution, parse_text
from fiesta.nodeconfig import NodeConfig
from fiesta.services.contributions import load_file


async def load_visible_parsed(
    session: AsyncSession,
    node: NodeConfig,
    contribution_id: int,
    private_key: str | None = None,
) -> tuple[Contribution, ParsedContribution]:
    """Fetch a contribution's parsed canonical file, honoring the same
    visibility rules as the core API (activated, or correct private key)."""
    contribution = await session.get(Contribution, contribution_id)
    if (
        contribution is None
        or contribution.deleted_at is not None
        or contribution.node != node.node.slug
        or contribution.filename is None
    ):
        raise HTTPException(404, f"contribution {contribution_id} not found")
    if not contribution.is_activated:
        try:
            supplied = uuid_mod.UUID(private_key) if private_key else None
        except ValueError:
            supplied = None
        if supplied != contribution.private_key:
            raise HTTPException(404, f"contribution {contribution_id} not found")
    raw = await load_file(node, contribution.id, contribution.filename)
    return contribution, parse_text(raw.decode("utf-8", errors="replace"))


def to_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
