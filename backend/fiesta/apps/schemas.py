"""API response/request models (see docs/api.md)."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, EmailStr

from fiesta.db.models import Contribution, User


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    orcid: str | None = None
    is_admin: bool = False  # super admin: every node, node creation, accounts
    admin_nodes: list[str] = []  # slugs of the nodes this user administers
    settings: dict = {}

    @classmethod
    def from_db(cls, user: User) -> "UserOut":
        return cls(
            id=user.id,
            email=user.email,
            name=user.name,
            orcid=user.orcid,
            is_admin=user.is_admin,
            admin_nodes=user.admin_nodes,
            settings=user.settings,
        )


class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    name: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class ContributionOut(BaseModel):
    id: int
    version: int
    previous_id: int | None
    contributor_id: int
    contributor_name: str | None = None
    private_key: str | None = None
    is_activated: bool
    is_latest: bool
    data_model_version: str
    reference_doi: str | None
    filename: str | None
    status: str
    head_revision: str | None = None
    published_revision: str | None = None
    indexing_status: str = "pending"
    error: str | None = None
    created_at: datetime
    updated_at: datetime
    activated_at: datetime | None

    @classmethod
    def from_db(
        cls, c: Contribution, *, include_private_key: bool, contributor_name: str | None = None
    ) -> "ContributionOut":
        return cls(
            id=c.id,
            version=c.version,
            previous_id=c.previous_id,
            contributor_id=c.contributor_id,
            contributor_name=contributor_name,
            private_key=str(c.private_key) if include_private_key else None,
            is_activated=c.is_activated,
            is_latest=c.is_latest,
            data_model_version=c.data_model_version,
            reference_doi=c.reference_doi,
            filename=c.filename,
            status=c.status.value,
            error=c.error,
            head_revision=c.head_revision,
            published_revision=c.published_revision,
            indexing_status=c.indexing_status,
            created_at=c.created_at,
            updated_at=c.updated_at,
            activated_at=c.activated_at,
        )


class ReferenceIn(BaseModel):
    doi: str
    expected_revision: str | None
    request_key: str


class ValidationOut(BaseModel):
    is_valid: bool
    validated_at: datetime
    errors: list[dict]
    warnings: list[dict]


class JobOut(BaseModel):
    job_id: int


class SearchPage(BaseModel):
    total: int
    results: list[dict[str, Any]]
    aggregations: dict[str, list[dict[str, Any]]] | None = None


class HealthOut(BaseModel):
    status: str
    database: bool
    search: bool
    storage: bool
