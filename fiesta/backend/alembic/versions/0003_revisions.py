"""Postgres authority, immutable revision history and durable processing outbox.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa

from alembic import context, op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    node = context.config.attributes["node_schema"]
    shared = context.config.attributes["shared_schema"]
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("users", schema=shared)}
    if "settings" not in columns:
        op.add_column(
            "users",
            sa.Column("settings", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
            schema=shared,
        )
    op.create_table(
        "workspaces",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey(f"{shared}.users.id"), nullable=False),
        schema=node,
    )
    op.create_table(
        "workspace_members",
        sa.Column(
            "workspace_id", sa.Integer(), sa.ForeignKey(f"{node}.workspaces.id"), primary_key=True
        ),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey(f"{shared}.users.id"), primary_key=True),
        sa.Column("role", sa.String(16), nullable=False),
        schema=node,
    )
    for col in [
        sa.Column("head_revision", sa.String(36)),
        sa.Column("published_revision", sa.String(36)),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("indexing_status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("workspace_id", sa.Integer(), sa.ForeignKey(f"{node}.workspaces.id")),
        sa.Column("seed_key", sa.String(255)),
    ]:
        op.add_column("contributions", col, schema=node)
    op.create_unique_constraint(
        "uq_contributions_seed_key", "contributions", ["seed_key"], schema=node
    )
    op.add_column("validation_results", sa.Column("revision_id", sa.String(36)), schema=node)
    op.add_column("validation_results", sa.Column("artifact_key", sa.Text()), schema=node)
    op.create_index(
        "ix_validation_results_revision_id", "validation_results", ["revision_id"], schema=node
    )
    op.create_table(
        "revisions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "contribution_id",
            sa.Integer(),
            sa.ForeignKey(f"{node}.contributions.id"),
            nullable=False,
        ),
        sa.Column("parent_id", sa.String(36)),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey(f"{shared}.users.id"), nullable=False),
        sa.Column("operation", sa.String(32), nullable=False),
        sa.Column("request_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("contribution_id", "request_key"),
        schema=node,
    )
    op.create_table(
        "outbox",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "contribution_id",
            sa.Integer(),
            sa.ForeignKey(f"{node}.contributions.id"),
            nullable=False,
        ),
        sa.Column("revision_id", sa.String(36)),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        schema=node,
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("contribution_id", sa.Integer()),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey(f"{shared}.users.id"), nullable=False),
        sa.Column("operation", sa.String(32), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        schema=node,
    )
    op.create_table(
        "legacy_imports",
        sa.Column("source_id", sa.String(255), primary_key=True),
        sa.Column(
            "contribution_id",
            sa.Integer(),
            sa.ForeignKey(f"{node}.contributions.id"),
            nullable=False,
        ),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("revision_id", sa.String(36)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        schema=node,
    )
    for table in ("revisions", "outbox", "audit_events"):
        op.create_index(f"ix_{table}_contribution_id", table, ["contribution_id"], schema=node)


def downgrade():
    raise RuntimeError(
        "Revision history cannot be discarded by downgrade; restore a backup instead"
    )
