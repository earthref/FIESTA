"""scope contributions to a node (multi-node deployments share one Postgres)

Rows created before this migration default to 'magic'.

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-05
"""

import sqlalchemy as sa

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "contributions",
        sa.Column("node", sa.String(32), nullable=False, server_default="magic"),
    )
    op.alter_column("contributions", "node", server_default=None)
    op.create_index("ix_contributions_node", "contributions", ["node"])


def downgrade() -> None:
    op.drop_index("ix_contributions_node", table_name="contributions")
    op.drop_column("contributions", "node")
