"""The OpenAlex work beside each cached DOI record (shared schema), and every
cached DOI made due so the next reference drain fetches it.

Runs once per node like every migration; whichever node migrates first adds
the column. Uses the resolved schema name: op.add_column renders the schema
literally and bypasses the schema_translate_map.

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-13
"""

import sqlalchemy as sa

from alembic import context, op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def _has_column(shared: str) -> bool:
    columns = sa.inspect(op.get_bind()).get_columns("doi_references", schema=shared)
    return any(c["name"] == "openalex" for c in columns)


def upgrade() -> None:
    shared = context.config.attributes["shared_schema"]
    if _has_column(shared):
        return
    op.add_column("doi_references", sa.Column("openalex", sa.JSON()), schema=shared)
    op.execute(
        sa.text(f"UPDATE \"{shared}\".doi_references SET due_at = now() WHERE status = 'ok'")
    )


def downgrade() -> None:
    shared = context.config.attributes["shared_schema"]
    if _has_column(shared):
        op.drop_column("doi_references", "openalex", schema=shared)
