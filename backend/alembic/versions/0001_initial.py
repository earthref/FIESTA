"""initial schema: users, contributions, validation_results

Revision ID: 0001
Revises:
Create Date: 2026-07-04
"""

import sqlalchemy as sa

from alembic import op

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
)


def upgrade() -> None:
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
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "contributions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("previous_id", sa.Integer(), sa.ForeignKey("contributions.id"), nullable=True),
        sa.Column("contributor_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
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
    )
    op.create_index("ix_contributions_contributor_id", "contributions", ["contributor_id"])
    op.create_index("ix_contributions_is_activated", "contributions", ["is_activated"])
    op.create_index("ix_contributions_is_latest", "contributions", ["is_latest"])

    op.create_table(
        "validation_results",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "contribution_id",
            sa.Integer(),
            sa.ForeignKey("contributions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("is_valid", sa.Boolean(), nullable=False),
        sa.Column("errors", sa.JSON(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("validated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_validation_results_contribution_id", "validation_results", ["contribution_id"]
    )


def downgrade() -> None:
    op.drop_table("validation_results")
    op.drop_table("contributions")
    op.drop_table("users")
    contribution_status.drop(op.get_bind(), checkfirst=True)
