"""Assistance requests: a user asks the node's admins for help with one of
their contributions (node schema).

create_table / create_index may use the NODE_SCHEMA token (the
schema_translate_map resolves it); the resolved name is used here anyway so the
existence check and the DDL agree.

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-15
"""

import sqlalchemy as sa

from alembic import context, op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    schema = context.config.attributes["node_schema"]
    shared = context.config.attributes["shared_schema"]
    if "assistance_requests" in sa.inspect(op.get_bind()).get_table_names(schema=schema):
        return
    op.create_table(
        "assistance_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "contribution_id",
            sa.Integer(),
            sa.ForeignKey(f"{schema}.contributions.id"),
            nullable=False,
        ),
        sa.Column(
            "requester_id", sa.Integer(), sa.ForeignKey(f"{shared}.users.id"), nullable=False
        ),
        sa.Column("reason", sa.String(16), nullable=False),
        sa.Column("message", sa.Text(), nullable=False, server_default=""),
        sa.Column("state", sa.String(16), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True)),
        sa.Column("closed_by", sa.Integer(), sa.ForeignKey(f"{shared}.users.id")),
        sa.Column("note", sa.Text()),
        schema=schema,
    )
    for column in ("contribution_id", "requester_id", "state"):
        op.create_index(
            f"ix_assistance_requests_{column}", "assistance_requests", [column], schema=schema
        )
    # One open request per contribution at a time.
    op.create_index(
        "uq_assistance_requests_open",
        "assistance_requests",
        ["contribution_id"],
        unique=True,
        schema=schema,
        postgresql_where=sa.text("state = 'open'"),
    )


def downgrade() -> None:
    schema = context.config.attributes["node_schema"]
    op.drop_table("assistance_requests", schema=schema)
