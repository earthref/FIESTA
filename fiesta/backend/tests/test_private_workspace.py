"""Private workspace routes that need no infrastructure: who may reassign a
contribution and download its file, with a fake session holding the rows."""

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fiesta.apps.routers import private
from fiesta.db.models import (
    AuditEvent,
    Contribution,
    ContributionStatus,
    NodeAdmin,
    Outbox,
    Revision,
    User,
    Workspace,
    WorkspaceMember,
)
from fiesta.services import contributions as svc

ADA, BOB, CAROL, ADMIN, OTHER_ADMIN, SUPER = 1, 2, 3, 4, 5, 6


def _users():
    return {
        ADA: User(id=ADA, email="ada@example.test", name="Ada", handle="ada", is_admin=False),
        BOB: User(id=BOB, email="bob@example.test", name="Bob", handle="bob", is_admin=False),
        # Carol edits Ada's shared workspace.
        CAROL: User(id=CAROL, email="carol@example.test", name="Carol", is_admin=False),
        ADMIN: User(
            id=ADMIN,
            email="admin@example.test",
            name="Admin",
            is_admin=False,
            node_roles=[NodeAdmin(user_id=ADMIN, node="magic")],
        ),
        OTHER_ADMIN: User(
            id=OTHER_ADMIN,
            email="cdr-admin@example.test",
            name="CDR Admin",
            is_admin=False,
            node_roles=[NodeAdmin(user_id=OTHER_ADMIN, node="cdr")],
        ),
        SUPER: User(id=SUPER, email="super@example.test", name="Super", is_admin=True),
    }


class FakeResult:
    def __init__(self, row):
        self.row = row

    def scalar_one(self):
        return self.row


class FakeSession:
    def __init__(self, contribution, revision=None):
        self.contribution = contribution
        self.revision = revision
        self.users = _users()
        self.workspace = Workspace(id=9, owner_id=ADA, name="Ada's lab")
        self.member = WorkspaceMember(workspace_id=9, user_id=CAROL, role="editor")
        self.added = []
        self.commits = 0

    async def get(self, model, pk):
        if model is Contribution:
            return self.contribution if pk == self.contribution.id else None
        if model is User:
            return self.users.get(pk)
        if model is Revision:
            return self.revision if self.revision and pk == self.revision.id else None
        if model is Workspace:
            return self.workspace if pk == self.workspace.id else None
        if model is WorkspaceMember:
            return self.member if pk == (self.member.workspace_id, self.member.user_id) else None
        return None

    async def execute(self, stmt):  # revisions.locked()
        return FakeResult(self.contribution)

    def add(self, row):
        self.added.append(row)

    async def commit(self):
        self.commits += 1


def _contribution(**fields) -> Contribution:
    values = {
        "id": 42,
        "node": "magic",
        "contributor_id": ADA,
        "is_activated": False,
        "is_latest": True,
        "private_key": uuid.uuid4(),
        "workspace_id": 9,
        "deleted_at": None,
        "head_revision": "rev-1",
        "version": 1,
        "data_model_version": "3.0",
        "status": ContributionStatus.READY,
        "indexing_status": "indexed",
        "created_at": datetime(2026, 11, 13, tzinfo=UTC),
        "updated_at": datetime(2026, 11, 13, tzinfo=UTC),
    }
    return Contribution(**{**values, **fields})


@pytest.fixture(autouse=True)
def accounts(monkeypatch):
    async def find_account(session, identifier):
        key = identifier.strip().removeprefix("@").lower()
        return next(
            (u for u in session.users.values() if key in (u.email, (u.handle or "").lower())),
            None,
        )

    monkeypatch.setattr(svc, "find_account", find_account)


def _node(slug="magic"):
    return SimpleNamespace(node=SimpleNamespace(slug=slug))


async def _reassign(session, actor, to="bob@example.test"):
    return await private.reassign(
        session,
        _node(),
        session.users[actor],
        session.contribution.id,
        private.ReassignIn(user=to),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("actor", [ADA, ADMIN, SUPER])
async def test_contributor_and_node_admins_reassign_a_private_contribution(actor):
    session = FakeSession(_contribution())
    out = await _reassign(session, actor, to="@BOB")
    assert session.contribution.contributor_id == BOB
    assert (out.contributor_id, out.contributor_name) == (BOB, "Bob")
    # The previous contributor no longer receives the private key.
    assert (out.private_key is None) == (actor == ADA)
    audit = [row for row in session.added if isinstance(row, AuditEvent)]
    assert [(a.operation, a.actor_id, a.details) for a in audit] == [
        ("reassign", actor, {"from": ADA, "to": BOB})
    ]
    # Re-indexing commits with the change, so search shows the new contributor.
    assert [row.kind for row in session.added if isinstance(row, Outbox)] == ["index"]
    assert session.commits == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("actor", "status"),
    [
        (CAROL, 403),  # a shared workspace's editor changes data, not ownership
        (BOB, 404),  # someone else's private contribution does not exist for him
        (OTHER_ADMIN, 404),  # another node's admin is nobody here
    ],
)
async def test_others_cannot_reassign(actor, status):
    session = FakeSession(_contribution())
    with pytest.raises(HTTPException) as err:
        await _reassign(session, actor, to="carol@example.test")
    assert err.value.status_code == status
    assert session.contribution.contributor_id == ADA and not session.added


@pytest.mark.asyncio
@pytest.mark.parametrize("actor", [ADA, ADMIN])
async def test_published_contributions_are_not_reassigned(actor):
    session = FakeSession(_contribution(is_activated=True))
    with pytest.raises(HTTPException) as err:
        await _reassign(session, actor)
    assert err.value.status_code == 409
    assert session.contribution.contributor_id == ADA and not session.added


@pytest.mark.asyncio
@pytest.mark.parametrize(("to", "status"), [("nobody@example.test", 404), ("ada", 409)])
async def test_reassign_needs_another_existing_account(to, status):
    session = FakeSession(_contribution())
    with pytest.raises(HTTPException) as err:
        await _reassign(session, ADA, to=to)
    assert err.value.status_code == status
    assert not session.added


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("actor", "allowed"), [(ADA, True), (CAROL, True), (ADMIN, True), (BOB, False)]
)
async def test_download_is_for_those_who_may_open_it(monkeypatch, actor, allowed):
    async def revision_file(session, node, contribution, name=None, revision_id=None):
        return b"tab\tcontribution\n"

    monkeypatch.setattr(private, "revision_file", revision_file)
    revision = Revision(
        id="rev-1",
        contribution_id=42,
        snapshot={"canonical": "magic_contribution_42.txt", "files": {}},
    )
    session = FakeSession(_contribution(), revision)
    call = private.download(session, _node(), session.users[actor], 42)
    if not allowed:
        with pytest.raises(HTTPException) as err:
            await call
        assert err.value.status_code == 404
        return
    response = await call
    assert response.body == b"tab\tcontribution\n"
    assert response.headers["content-disposition"] == (
        'attachment; filename="magic_contribution_42.txt"'
    )
