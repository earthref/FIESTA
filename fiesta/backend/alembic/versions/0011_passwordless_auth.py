"""Passwordless sign-in (shared schema): profile fields publication requires
(first and last name, affiliation, a verified email), the external sign-ins
(Google, Microsoft, GitHub, ORCID) linked to each account, and one-time tokens
(emailed sign-in links, OAuth hand-offs).

The migration runs once per node schema against one shared schema, so every
step checks before it creates. add_column renders its schema literally: the
resolved shared schema is used, never a token.

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-24
"""

import sqlalchemy as sa

from alembic import context, op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

PROFILE_COLUMNS = {
    "first_name": sa.String(255),
    "last_name": sa.String(255),
    "affiliation": sa.String(512),
    "email_verified_at": sa.DateTime(timezone=True),
}


def upgrade() -> None:
    shared = context.config.attributes["shared_schema"]
    inspector = sa.inspect(op.get_bind())
    columns = {c["name"] for c in inspector.get_columns("users", schema=shared)}
    for name, type_ in PROFILE_COLUMNS.items():
        if name not in columns:
            op.add_column("users", sa.Column(name, type_), schema=shared)
    tables = inspector.get_table_names(schema=shared)
    if "user_identities" not in tables:
        op.create_table(
            "user_identities",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey(f"{shared}.users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("provider", sa.String(32), nullable=False),
            sa.Column("subject", sa.String(255), nullable=False),
            sa.Column("email", sa.String(255)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_login_at", sa.DateTime(timezone=True)),
            sa.UniqueConstraint("provider", "subject", name="uq_user_identities_subject"),
            schema=shared,
        )
        op.create_index("ix_user_identities_user_id", "user_identities", ["user_id"], schema=shared)
    if "login_tokens" not in tables:
        op.create_table(
            "login_tokens",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
            sa.Column("purpose", sa.String(16), nullable=False),
            sa.Column("email", sa.String(255)),
            sa.Column(
                "user_id", sa.Integer(), sa.ForeignKey(f"{shared}.users.id", ondelete="CASCADE")
            ),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("used_at", sa.DateTime(timezone=True)),
            sa.Column("payload", sa.JSON()),
            schema=shared,
        )
        op.create_index("ix_login_tokens_email", "login_tokens", ["email"], schema=shared)


def downgrade() -> None:
    shared = context.config.attributes["shared_schema"]
    tables = sa.inspect(op.get_bind()).get_table_names(schema=shared)
    for table in ("login_tokens", "user_identities"):
        if table in tables:
            op.drop_table(table, schema=shared)
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("users", schema=shared)}
    for name in PROFILE_COLUMNS:
        if name in columns:
            op.drop_column("users", name, schema=shared)
