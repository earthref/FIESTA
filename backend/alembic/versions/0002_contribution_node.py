"""record the node slug on each contribution row

Rows created before this migration default to the migrating node's slug.

Uses the resolved schema name (config.attributes["node_schema"], set by
env.py) rather than the NODE_SCHEMA token: op.add_column / op.alter_column
emit ALTER TABLE with the schema rendered literally, bypassing the
schema_translate_map that op.create_table / op.create_index honor.

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-05
"""

import sqlalchemy as sa

from alembic import context, op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    schema = context.config.attributes["node_schema"]
    op.add_column(
        "contributions",
        sa.Column("node", sa.String(32), nullable=False, server_default=schema),
        schema=schema,
    )
    op.alter_column("contributions", "node", server_default=None, schema=schema)
    op.create_index("ix_contributions_node", "contributions", ["node"], schema=schema)


def downgrade() -> None:
    schema = context.config.attributes["node_schema"]
    op.drop_index("ix_contributions_node", table_name="contributions", schema=schema)
    op.drop_column("contributions", "node", schema=schema)
