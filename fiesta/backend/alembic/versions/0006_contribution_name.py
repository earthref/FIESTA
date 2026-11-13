"""the contributor's own name for a contribution (legacy summary.contribution._name)

Uses the resolved schema name (config.attributes["node_schema"]): op.add_column
renders the schema literally and bypasses the schema_translate_map.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-12
"""

import sqlalchemy as sa

from alembic import context, op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    schema = context.config.attributes["node_schema"]
    op.add_column("contributions", sa.Column("name", sa.String(255)), schema=schema)


def downgrade() -> None:
    schema = context.config.attributes["node_schema"]
    op.drop_column("contributions", "name", schema=schema)
