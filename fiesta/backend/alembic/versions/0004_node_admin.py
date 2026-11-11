"""Node admins and node configuration revisions (shared schema).

Runs once per node like every migration; the shared tables are created by
whichever node migrates first.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa

from alembic import context, op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    shared = context.config.attributes["shared_schema"]
    existing = set(sa.inspect(op.get_bind()).get_table_names(schema=shared))
    if "node_admins" not in existing:
        op.create_table(
            "node_admins",
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey(f"{shared}.users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("node", sa.String(32), primary_key=True),
            sa.Column("granted_by", sa.Integer(), sa.ForeignKey(f"{shared}.users.id")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            schema=shared,
        )
        op.create_index("ix_node_admins_node", "node_admins", ["node"], schema=shared)
    if "config_blobs" not in existing:
        op.create_table(
            "config_blobs",
            sa.Column("sha256", sa.String(64), primary_key=True),
            sa.Column("content", sa.LargeBinary(), nullable=False),
            schema=shared,
        )
    if "nodes" not in existing:
        op.create_table(
            "nodes",
            sa.Column("slug", sa.String(32), primary_key=True),
            sa.Column("key", sa.String(32), nullable=False, unique=True),
            sa.Column("published_revision_id", sa.Integer()),
            sa.Column("draft_revision_id", sa.Integer()),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey(f"{shared}.users.id")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            schema=shared,
        )
    if "node_revisions" not in existing:
        op.create_table(
            "node_revisions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("node", sa.String(32), nullable=False),
            sa.Column("number", sa.Integer(), nullable=False),
            sa.Column("parent_id", sa.Integer()),
            sa.Column("files", sa.JSON(), nullable=False),
            sa.Column("tree_hash", sa.String(64), nullable=False),
            sa.Column("state", sa.String(16), nullable=False),
            sa.Column("source", sa.String(8), nullable=False),
            sa.Column("message", sa.Text()),
            sa.Column("lock_version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("author_id", sa.Integer(), sa.ForeignKey(f"{shared}.users.id")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("published_by", sa.Integer(), sa.ForeignKey(f"{shared}.users.id")),
            sa.Column("published_at", sa.DateTime(timezone=True)),
            sa.Column("repo_status", sa.String(16)),
            sa.Column("repo_ref", sa.Text()),
            sa.Column("repo_error", sa.Text()),
            sa.UniqueConstraint("node", "number"),
            schema=shared,
        )
        op.create_index("ix_node_revisions_node", "node_revisions", ["node"], schema=shared)


def downgrade():
    raise RuntimeError(
        "Node configuration history cannot be discarded by downgrade; restore a backup instead"
    )
