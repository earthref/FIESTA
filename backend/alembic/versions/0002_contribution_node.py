"""record the node slug on each contribution row

Rows created before this migration default to the migrating node's slug.

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-05
"""

import sqlalchemy as sa

from alembic import context, op
from fiesta.db.base import NODE_SCHEMA

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    slug = context.config.attributes.get("node_slug") or "magic"
    op.add_column(
        "contributions",
        sa.Column("node", sa.String(32), nullable=False, server_default=slug),
        schema=NODE_SCHEMA,
    )
    op.alter_column("contributions", "node", server_default=None, schema=NODE_SCHEMA)
    op.create_index("ix_contributions_node", "contributions", ["node"], schema=NODE_SCHEMA)


def downgrade() -> None:
    op.drop_index("ix_contributions_node", table_name="contributions", schema=NODE_SCHEMA)
    op.drop_column("contributions", "node", schema=NODE_SCHEMA)
