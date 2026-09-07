"""Workflow metadata models.

Postgres is the source of truth for accounts and the contribution workflow
state machine. Accounts live in the shared schema; every node's workflow
tables live in a schema named after the node (see fiesta.db.base).
Contribution *data* lives in the storage bucket (canonical files +
manifests) and OpenSearch (denormalized search documents); both the
contributions table and the search index can be rebuilt from the bucket
(`fiesta rebuild`).
"""

import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, ForeignKey, Integer, String, Text
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
    is_valid: Mapped[bool] = mapped_column(Boolean)
    errors: Mapped[list] = mapped_column(JSON, default=list)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    validated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    contribution: Mapped[Contribution] = relationship(back_populates="validations")
