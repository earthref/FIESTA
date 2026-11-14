"""Per-user import settings templates for the upload page (shared schema).

Runs once per node like every migration; whichever node migrates first creates
the table.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-13
"""

import sqlalchemy as sa

from alembic import context, op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    shared = context.config.attributes["shared_schema"]
    if "import_templates" in sa.inspect(op.get_bind()).get_table_names(schema=shared):
        return
    op.create_table(
        "import_templates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey(f"{shared}.users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("node", sa.String(32), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("settings", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "node", "name"),
        schema=shared,
    )
    op.create_index("ix_import_templates_user_id", "import_templates", ["user_id"], schema=shared)


def downgrade() -> None:
    shared = context.config.attributes["shared_schema"]
    if "import_templates" in sa.inspect(op.get_bind()).get_table_names(schema=shared):
        op.drop_table("import_templates", schema=shared)
