"""Publication metadata by DOI (shared schema): the Crossref/DataCite cache
behind summary.contribution._reference.

Runs once per node like every migration; the shared table is created by
whichever node migrates first.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa

from alembic import context, op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def _exists(shared: str) -> bool:
    return "doi_references" in sa.inspect(op.get_bind()).get_table_names(schema=shared)


def upgrade():
    shared = context.config.attributes["shared_schema"]
    if _exists(shared):
        return
    op.create_table(
        "doi_references",
        sa.Column("doi", sa.String(255), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("source", sa.String(16)),
        sa.Column("reference", sa.JSON()),
        sa.Column("raw", sa.JSON()),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text()),
        sa.Column("fetched_at", sa.DateTime(timezone=True)),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        schema=shared,
    )
    op.create_index("ix_doi_references_due_at", "doi_references", ["due_at"], schema=shared)


def downgrade():
    shared = context.config.attributes["shared_schema"]
    if _exists(shared):
        op.drop_table("doi_references", schema=shared)
