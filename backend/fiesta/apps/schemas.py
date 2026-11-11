"""API response/request models (see docs/api.md)."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field

from fiesta.db.models import Contribution, User


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    handle: str | None = None
    orcid: str | None = None
    has_password: bool = False  # False for an account imported without one
    is_admin: bool = False  # super admin: every node, node creation, accounts
    admin_nodes: list[str] = []  # slugs of the nodes this user administers
    settings: dict = {}

    @classmethod
    def from_db(cls, user: User) -> "UserOut":
        return cls(
            id=user.id,
            email=user.email,
            name=user.name,
            handle=user.handle,
            orcid=user.orcid,
            has_password=user.password_hash is not None,
            is_admin=user.is_admin,
            admin_nodes=user.admin_nodes,
            settings=user.settings,
        )


class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    name: str


class AccountPatchIn(BaseModel):
    """The signed-in user's own account fields (PATCH /v2/auth/me); an empty
    handle or ORCID clears it."""

    email: EmailStr | None = None
    name: str | None = Field(default=None, min_length=1, max_length=255)
    # No "@": login accepts an email or a handle in the same field.
    handle: str | None = Field(default=None, pattern=r"^([A-Za-z0-9_.-]{2,64})?$")
    orcid: str | None = Field(default=None, pattern=r"^(\d{4}-\d{4}-\d{4}-\d{3}[\dX])?$")


class PasswordIn(BaseModel):
    # Required when the account already has a password.
    current_password: str | None = None
    new_password: str = Field(min_length=8)


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
    # With `totals`: the matches' rows (summed count_field) and positioned docs.
    rows_total: int | None = None
    mapped_total: int | None = None


class MapPoint(BaseModel):
    id: Any = None  # the contribution
    name: str | None = None  # the level row's key column
    lat: float
    lon: float
    count: int | None = None  # records at this location (the aggregated map)
    value: float | None = None  # its `color_by` number (a location's records' mean)
    body: str | None = None  # another planetary body it is on ("moon"); None: Earth


class MapPoints(BaseModel):
    total: int
    points: list[MapPoint]
    truncated: bool = False


class SearchValues(BaseModel):
    total: int
    fields: list[str]
    rows: list[list[int | float | str | None]]
    truncated: bool = False


class HealthOut(BaseModel):
    status: str
    database: bool
    search: bool
    storage: bool
