"""initial schema: users (shared schema), contributions + validation_results (node schema)

Runs once per node (see alembic/env.py). The shared `users` table is created
by whichever node migrates first and skipped afterwards.

Revision ID: 0001
Revises:
Create Date: 2026-07-04
"""

import sqlalchemy as sa

from alembic import op
from fiesta.db.base import NODE_SCHEMA, SHARED_SCHEMA
from fiesta.settings import get_settings

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

contribution_status = sa.Enum(
    "created",
    "uploaded",
    "parsing",
    "validating",
    "summarizing",
    "ready",
    "failed",
    name="contributionstatus",
    schema=NODE_SCHEMA,
)


def _shared_table_exists(name: str) -> bool:
    # Inspection bypasses the translate map, so ask for the real schema name.
    return sa.inspect(op.get_bind()).has_table(name, schema=get_settings().db_shared_schema)


def upgrade() -> None:
    if not _shared_table_exists("users"):
        op.create_table(
            "users",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("email", sa.String(255), nullable=False),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("handle", sa.String(255), nullable=True),
            sa.Column("orcid", sa.String(19), nullable=True),
            sa.Column("password_hash", sa.String(255), nullable=True),
            sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("handle"),
            sa.UniqueConstraint("orcid"),
            schema=SHARED_SCHEMA,
        )
        op.create_index("ix_users_email", "users", ["email"], unique=True, schema=SHARED_SCHEMA)

    op.create_table(
        "contributions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column(
            "previous_id",
            sa.Integer(),
            sa.ForeignKey(f"{NODE_SCHEMA}.contributions.id"),
            nullable=True,
        ),
        sa.Column(
            "contributor_id",
            sa.Integer(),
            sa.ForeignKey(f"{SHARED_SCHEMA}.users.id"),
            nullable=False,
        ),
        sa.Column("private_key", sa.Uuid(), nullable=False),
        sa.Column("is_activated", sa.Boolean(), nullable=False),
        sa.Column("is_latest", sa.Boolean(), nullable=False),
        sa.Column("data_model_version", sa.String(8), nullable=False),
        sa.Column("reference_doi", sa.String(255), nullable=True),
        sa.Column("filename", sa.String(255), nullable=True),
        sa.Column("status", contribution_status, nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("private_key"),
        schema=NODE_SCHEMA,
    )
    for column in ("contributor_id", "is_activated", "is_latest"):
        op.create_index(
            f"ix_contributions_{column}", "contributions", [column], schema=NODE_SCHEMA
        )

    op.create_table(
        "validation_results",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "contribution_id",
            sa.Integer(),
            sa.ForeignKey(f"{NODE_SCHEMA}.contributions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("is_valid", sa.Boolean(), nullable=False),
        sa.Column("errors", sa.JSON(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("validated_at", sa.DateTime(timezone=True), nullable=False),
        schema=NODE_SCHEMA,
    )
    op.create_index(
        "ix_validation_results_contribution_id",
        "validation_results",
        ["contribution_id"],
        schema=NODE_SCHEMA,
    )


def downgrade() -> None:
    # Only this node's schema; the shared users table stays for the others.
    op.drop_table("validation_results", schema=NODE_SCHEMA)
    op.drop_table("contributions", schema=NODE_SCHEMA)
    contribution_status.drop(op.get_bind(), checkfirst=True)
