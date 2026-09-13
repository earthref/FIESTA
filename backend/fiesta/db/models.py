"""Workflow metadata models.

Postgres is the source of truth for accounts and the contribution workflow
state machine. Accounts live in the shared schema; every node's workflow
tables live in a schema named after the node (see fiesta.db.base).
Contribution bytes and immutable revision manifests live in the bucket; OpenSearch
is a denormalized search projection. Account state and revision pointers require
Postgres backups; index rebuild never restores or replaces database rows.
"""

import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from fiesta.db.base import NODE_SCHEMA, SHARED_SCHEMA, Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class User(Base):
    __tablename__ = "users"
    __table_args__ = {"schema": SHARED_SCHEMA}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    handle: Mapped[str | None] = mapped_column(String(255), unique=True)
    orcid: Mapped[str | None] = mapped_column(String(19), unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    settings: Mapped[dict] = mapped_column(JSON, default=dict)

    contributions: Mapped[list["Contribution"]] = relationship(back_populates="contributor")


class ContributionStatus(enum.StrEnum):
    CREATED = "created"  # id allocated, no file yet
    UPLOADED = "uploaded"  # file stored, processing queued
    PARSING = "parsing"
    VALIDATING = "validating"
    SUMMARIZING = "summarizing"
    READY = "ready"  # parsed + summarized + indexed
    FAILED = "failed"


class Contribution(Base):
    """One row per contribution *version* (matching the legacy model where
    each published version gets its own integer id, chained by previous_id)."""

    __tablename__ = "contributions"
    __table_args__ = {"schema": NODE_SCHEMA}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Node slug (magic, cdr, ...). Each node has its own schema, so this is
    # redundant with the schema the row lives in; it is kept because manifests
    # carry it and the public API double-checks it. Users are shared (one
    # EarthRef account works on every node).
    node: Mapped[str] = mapped_column(String(32), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    previous_id: Mapped[int | None] = mapped_column(ForeignKey(f"{NODE_SCHEMA}.contributions.id"))
    contributor_id: Mapped[int] = mapped_column(ForeignKey(f"{SHARED_SCHEMA}.users.id"), index=True)
    private_key: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4, unique=True)
    is_activated: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    is_latest: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    data_model_version: Mapped[str] = mapped_column(String(8))
    reference_doi: Mapped[str | None] = mapped_column(String(255))
    filename: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[ContributionStatus] = mapped_column(
        Enum(
            ContributionStatus,
            values_callable=lambda e: [m.value for m in e],
            schema=NODE_SCHEMA,  # one enum type per node schema
        ),
        default=ContributionStatus.CREATED,
    )
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    head_revision: Mapped[str | None] = mapped_column(String(36))
    published_revision: Mapped[str | None] = mapped_column(String(36))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    indexing_status: Mapped[str] = mapped_column(String(16), default="pending")
    workspace_id: Mapped[int | None] = mapped_column(ForeignKey(f"{NODE_SCHEMA}.workspaces.id"))
    seed_key: Mapped[str | None] = mapped_column(String(255), unique=True)

    contributor: Mapped[User] = relationship(back_populates="contributions")
    validations: Mapped[list["ValidationResult"]] = relationship(
        back_populates="contribution", cascade="all, delete-orphan"
    )


class ValidationResult(Base):
    __tablename__ = "validation_results"
    __table_args__ = {"schema": NODE_SCHEMA}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    contribution_id: Mapped[int] = mapped_column(
        ForeignKey(f"{NODE_SCHEMA}.contributions.id", ondelete="CASCADE"), index=True
    )
    revision_id: Mapped[str | None] = mapped_column(String(36), index=True)
    artifact_key: Mapped[str | None] = mapped_column(Text)
    is_valid: Mapped[bool] = mapped_column(Boolean)
    errors: Mapped[list] = mapped_column(JSON, default=list)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    validated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    contribution: Mapped[Contribution] = relationship(back_populates="validations")


class Workspace(Base):
    __tablename__ = "workspaces"
    __table_args__ = {"schema": NODE_SCHEMA}
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    owner_id: Mapped[int] = mapped_column(ForeignKey(f"{SHARED_SCHEMA}.users.id"))


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"
    __table_args__ = {"schema": NODE_SCHEMA}
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey(f"{NODE_SCHEMA}.workspaces.id"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey(f"{SHARED_SCHEMA}.users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(16))


class Revision(Base):
    __tablename__ = "revisions"
    __table_args__ = (UniqueConstraint("contribution_id", "request_key"), {"schema": NODE_SCHEMA})
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    contribution_id: Mapped[int] = mapped_column(
        ForeignKey(f"{NODE_SCHEMA}.contributions.id"), index=True
    )
    parent_id: Mapped[str | None] = mapped_column(String(36))
    actor_id: Mapped[int] = mapped_column(ForeignKey(f"{SHARED_SCHEMA}.users.id"))
    operation: Mapped[str] = mapped_column(String(32))
    request_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    snapshot: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Outbox(Base):
    __tablename__ = "outbox"
    __table_args__ = {"schema": NODE_SCHEMA}
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    contribution_id: Mapped[int] = mapped_column(
        ForeignKey(f"{NODE_SCHEMA}.contributions.id"), index=True
    )
    revision_id: Mapped[str | None] = mapped_column(String(36))
    kind: Mapped[str] = mapped_column(String(16), default="process")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = {"schema": NODE_SCHEMA}
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    contribution_id: Mapped[int | None] = mapped_column(Integer, index=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey(f"{SHARED_SCHEMA}.users.id"))
    operation: Mapped[str] = mapped_column(String(32))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LegacyImport(Base):
    __tablename__ = "legacy_imports"
    __table_args__ = {"schema": NODE_SCHEMA}
    source_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    contribution_id: Mapped[int] = mapped_column(ForeignKey(f"{NODE_SCHEMA}.contributions.id"))
    fingerprint: Mapped[str] = mapped_column(String(64))
    revision_id: Mapped[str | None] = mapped_column(String(36))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
