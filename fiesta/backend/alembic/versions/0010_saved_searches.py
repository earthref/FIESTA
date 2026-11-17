"""Saved searches: a search page's state behind a short URL id, and every run
or opening of one (node schema).

create_table / create_index may use the NODE_SCHEMA token (the
schema_translate_map resolves it); the resolved name is used here anyway so the
existence check and the DDL agree.

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-17
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import context, op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    schema = context.config.attributes["node_schema"]
    shared = context.config.attributes["shared_schema"]
    tables = sa.inspect(op.get_bind()).get_table_names(schema=schema)
    if "searches" not in tables:
        op.create_table(
            "searches",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("state", postgresql.JSONB(), nullable=False),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey(f"{shared}.users.id")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("use_count", sa.Integer(), nullable=False, server_default="1"),
            schema=schema,
        )
        op.create_index("ix_searches_last_used_at", "searches", ["last_used_at"], schema=schema)
    if "search_uses" not in tables:
        op.create_table(
            "search_uses",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "search_id", sa.Uuid(), sa.ForeignKey(f"{schema}.searches.id"), nullable=False
            ),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey(f"{shared}.users.id")),
            sa.Column("kind", sa.String(8), nullable=False),
            sa.Column("level", sa.String(64)),
            sa.Column("view", sa.String(64)),
            sa.Column("used_at", sa.DateTime(timezone=True), nullable=False),
            schema=schema,
        )
        for column in ("search_id", "used_at"):
            op.create_index(f"ix_search_uses_{column}", "search_uses", [column], schema=schema)


def downgrade() -> None:
    schema = context.config.attributes["node_schema"]
    op.drop_table("search_uses", schema=schema)
    op.drop_table("searches", schema=schema)
