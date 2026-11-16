"""Private workspace routes that need no infrastructure: who may reassign a
contribution, download its file, prepare and publish a new version, and see
or act on an assistance request, with a fake session holding the rows."""

import hashlib
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fiesta.apps.deps import require_public_contributions
from fiesta.apps.routers import assistance, private
from fiesta.db.models import (
    AssistanceRequest,
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
from fiesta.jobs import tasks
from fiesta.services import contributions as svc
from fiesta.services import downloads
from fiesta.services.access import chain_contributors

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

    def scalars(self):
        return iter(self.row)


class FakeSession:
    """`contribution` is the one a test acts on; `others` are more rows (the
    earlier versions of a chain)."""

    def __init__(self, contribution, revision=None, others=()):
        self.contribution = contribution
        self.contributions = {c.id: c for c in (contribution, *others)}
        self.requests: dict[int, AssistanceRequest] = {}
        self.revision = revision
        self.users = _users()
        self.workspace = Workspace(id=9, owner_id=ADA, name="Ada's lab")
        self.member = WorkspaceMember(workspace_id=9, user_id=CAROL, role="editor")
        self.added = []
        self.commits = 0

    async def get(self, model, pk):
        if model is Contribution:
            return self.contributions.get(pk)
        if model is AssistanceRequest:
            return self.requests.get(pk)
        if model is User:
            return self.users.get(pk)
        if model is Revision:
            return self.revision if self.revision and pk == self.revision.id else None
        if model is Workspace:
            return self.workspace if pk == self.workspace.id else None
        if model is WorkspaceMember:
            return self.member if pk == (self.member.workspace_id, self.member.user_id) else None
        return None

    async def execute(self, stmt):
        entity = stmt.column_descriptions[0]["entity"]
        if entity is AssistanceRequest:  # the routes re-check what they asked for
            return FakeResult(list(self.requests.values()))
        params = stmt.compile().params
        if "node_1" in params:  # the workspace list: every row on the node
            rows = self.contributions.values()
            return FakeResult([c for c in rows if c.node == params["node_1"]])
        (pk,) = stmt.compile().params.values()  # revisions.locked()
        return FakeResult(self.contributions[pk])

    def add(self, row):
        self.added.append(row)

    async def flush(self):
        for row in self.added:
            if isinstance(row, AssistanceRequest) and row.id is None:
                row.id = len(self.requests) + 1
                self.requests[row.id] = row
            if isinstance(row, Contribution) and row.id is None:
                row.id = max(self.contributions) + 1
                # The column defaults Postgres would apply.
                defaults = _contribution(id=row.id, workspace_id=None, head_revision=None)
                for column in (
                    "status",
                    "is_activated",
                    "is_latest",
                    "private_key",
                    "created_at",
                    "updated_at",
                    "indexing_status",
                ):
                    setattr(row, column, getattr(defaults, column))
                self.contributions[row.id] = row

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
    return SimpleNamespace(
        node=SimpleNamespace(
            slug=slug, key="MagIC", links=SimpleNamespace(website="https://earthref.test/MagIC")
        ),
        workspace=SimpleNamespace(require_reference=False),
    )


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
async def test_download_is_for_those_who_may_open_it(monkeypatch, magic_node, actor, allowed):
    stored = "﻿tab delimited\tcontribution\nreference\n10.1/x\n".encode()

    async def read(node, file):
        return stored

    monkeypatch.setattr(downloads, "read", read)
    name = "magic_contribution_42.txt"
    entry = {"key": "k", "sha256": hashlib.sha256(stored).hexdigest(), "size": len(stored)}
    revision = Revision(
        id="rev-1",
        contribution_id=42,
        snapshot={"canonical": name, "files": {name: entry}, "data_model_version": "3.0"},
    )
    session = FakeSession(_contribution(), revision)
    call = private.download(session, magic_node, session.users[actor], 42)
    if not allowed:
        with pytest.raises(HTTPException) as err:
            await call
        assert err.value.status_code == 404
        return
    response = await call
    # Prepared like the public download: no BOM, the workflow's download-only
    # values (unpublished: no timestamp), the contributor by name.
    assert response.body == (
        b"tab delimited\tcontribution\n"
        b"id\treference\tversion\tcontributor\tdata_model_version\n"
        b"42\t10.1/x\t1\tAda\t3.0\n"
    )
    assert response.headers["content-disposition"] == f'attachment; filename="{name}"'
    assert response.headers["x-checksum-sha256"] == hashlib.sha256(response.body).hexdigest()
    assert response.headers["x-stored-sha256"] == entry["sha256"]
    original = await private.download(session, magic_node, session.users[actor], 42, original=True)
    assert original.body == stored


# -- new versions: anyone signed in prepares one; its chain or an admin publishes --

V1, V2, DRAFT = 40, 41, 42


def _chain(drafter, **draft_fields):
    """Ada published version 1, Carol version 2 (the latest); DRAFTER has
    prepared version 3, privately, outside any shared workspace."""
    published = {"is_activated": True, "workspace_id": None, "published_revision": "rev-p"}
    v1 = _contribution(id=V1, contributor_id=ADA, version=1, is_latest=False, **published)
    v2 = _contribution(id=V2, contributor_id=CAROL, version=2, previous_id=V1, **published)
    fields = {"workspace_id": None, **draft_fields}
    draft = _contribution(id=DRAFT, contributor_id=drafter, version=3, previous_id=V2, **fields)
    return FakeSession(draft, others=(v1, v2))


@pytest.fixture
def outbox(monkeypatch):
    """The emails the routes queue, and a passing validation for every
    contribution."""
    sent = []

    async def defer_async(**email):
        sent.append(email)

    async def latest_validation(session, contribution_id):
        return SimpleNamespace(
            is_valid=True, errors=[], warnings=[{"message": "w"}], validated_at=datetime.now(UTC)
        )

    monkeypatch.setattr(tasks.send_email, "defer_async", defer_async)
    monkeypatch.setattr(svc, "latest_validation", latest_validation)
    return sent


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("drafter", "actor", "outcome"),
    [
        (ADA, ADA, 200),  # contributor of an earlier version (not only the last one)
        (CAROL, CAROL, 200),  # contributor of the version it follows
        (BOB, BOB, 403),  # anyone else: an admin has to approve it
        (BOB, ADMIN, 200),  # a node admin approves it ...
        (BOB, SUPER, 200),  # ... as does a super admin without a node role
        (BOB, OTHER_ADMIN, 404),  # another node's admin cannot even open it
        (BOB, ADA, 404),  # a chain contributor cannot open someone's private draft
    ],
)
async def test_publish_permission_matrix(outbox, drafter, actor, outcome):
    session = _chain(drafter)
    call = private.activate(session, _node(), session.users[actor], DRAFT)
    if outcome != 200:
        with pytest.raises(HTTPException) as err:
            await call
        assert err.value.status_code == outcome
        assert not session.contribution.is_activated and not outbox
        if outcome == 403:
            assert "an admin has to approve" in err.value.detail
        return
    out = await call
    draft = session.contribution
    assert draft.is_activated and out.is_activated
    # Approving publishes it for the drafter: it stays theirs, and joins the
    # chain whose contributors may publish its successors.
    assert draft.contributor_id == drafter
    assert (out.contributor_id, out.contributor_name) == (drafter, session.users[drafter].name)
    assert drafter in await chain_contributors(session, _contribution(id=99, previous_id=DRAFT))
    assert session.contributions[V2].is_latest is False
    publish = [r for r in session.added if isinstance(r, AuditEvent)]
    assert [(a.operation, a.actor_id) for a in publish] == [("publish", actor)]
    assert [m["to"] for m in outbox] == [session.users[drafter].email]
    assert ("approved by" in outbox[0]["body"]) == (actor != drafter)


@pytest.mark.asyncio
async def test_first_versions_publish_as_before(outbox):
    # No chain: whoever may save it publishes it (a shared workspace's editor too).
    session = FakeSession(_contribution())
    out = await private.activate(session, _node(), session.users[CAROL], 42)
    assert out.is_activated and out.contributor_id == ADA


@pytest.mark.asyncio
async def test_publish_refused_once_another_version_superseded_it(outbox):
    session = _chain(ADA)
    session.contributions[V2].is_latest = False
    with pytest.raises(HTTPException) as err:
        await private.activate(session, _node(), session.users[ADA], DRAFT)
    assert err.value.status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize(("actor", "can_publish"), [(BOB, False), (ADMIN, True), (SUPER, True)])
async def test_workspace_card_says_who_may_publish(actor, can_publish):
    session = _chain(BOB)
    out = await private.get_contribution(session, _node(), session.users[actor], DRAFT)
    assert out.can_publish is can_publish
    # Every card names its owner, whoever is looking.
    assert (out.contributor_name, out.contributor_handle) == ("Bob", "bob")


@pytest.fixture
def copies(monkeypatch):
    """new_version's revision plumbing, recorded instead of stored."""
    saved = []

    async def snapshot_for(session, contribution):
        return {"files": {"f.txt": {}}, "canonical": "f.txt", "reference_doi": None}

    async def revision_file(session, node, contribution, name=None, revision_id=None):
        return b"tab\tcontribution\n"

    async def save_revision(session, node, contribution, actor_id, **kwargs):
        saved.append((contribution.id, actor_id, kwargs["operation"]))

    monkeypatch.setattr(private, "snapshot_for", snapshot_for)
    monkeypatch.setattr(private, "revision_file", revision_file)
    monkeypatch.setattr(private, "save_revision", save_revision)
    return saved


@pytest.mark.asyncio
async def test_anyone_signed_in_prepares_a_new_version_of_a_published_one(copies):
    session = _chain(ADA)
    out = await private.new_version(session, _node(), session.users[BOB], V2)
    assert (out.contributor_id, out.version, out.previous_id) == (BOB, 3, V2)
    assert out.can_publish is False  # Bob is not in the chain: an admin approves it
    created = session.contributions[out.id]
    assert created.workspace_id is None  # a stranger's draft joins no shared workspace
    assert copies == [(out.id, BOB, "new-version")]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("target", "status"),
    [
        (V1, 409),  # not the latest version
        (DRAFT, 404),  # someone else's private draft
    ],
)
async def test_new_versions_start_from_the_latest_published_one(copies, target, status):
    session = _chain(ADA)
    with pytest.raises(HTTPException) as err:
        await private.new_version(session, _node(), session.users[BOB], target)
    assert err.value.status_code == status
    assert not copies


# -- assistance requests ----------------------------------------------------------


@pytest.fixture
def admins(monkeypatch):
    async def node_admin_emails(session, slug):
        return ["admin@example.test"]

    monkeypatch.setattr(assistance, "node_admin_emails", node_admin_emails)


async def _ask(session, actor=BOB, reason="approve"):
    return await assistance.open_request(
        session,
        _node(),
        session.users[actor],
        DRAFT,
        assistance.RequestIn(reason=reason, message="  Please approve my corrections. "),
    )


def test_request_writes_are_refused_in_data_source_mode():
    assert any(d.dependency is require_public_contributions for d in assistance.router.dependencies)


@pytest.mark.asyncio
async def test_opening_a_request_emails_the_node_admins(outbox, admins):
    session = _chain(BOB)
    request = await _ask(session)
    assert (request.state, request.reason, request.message) == (
        "open",
        "approve",
        "Please approve my corrections.",
    )
    assert (request.requester_name, request.requester_handle) == ("Bob", "bob")
    audit = [(a.operation, a.actor_id) for a in session.added if isinstance(a, AuditEvent)]
    assert audit == [("request-open", BOB)]
    assert [m["to"] for m in outbox] == ["admin@example.test"]
    assert "approve a new version" in outbox[0]["subject"]
    # One open request per contribution.
    with pytest.raises(HTTPException) as err:
        await _ask(session, reason="other")
    assert err.value.status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize("actor", [CAROL, ADA, OTHER_ADMIN])
async def test_only_who_may_save_it_asks_for_help(outbox, admins, actor):
    session = _chain(BOB)
    with pytest.raises(HTTPException) as err:
        await _ask(session, actor=actor)
    assert err.value.status_code == 404 and not session.requests


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("actor", "mine", "node", "history"),
    [
        (BOB, 1, 403, 1),  # the requester sees his own, not the node's queue
        (ADMIN, 0, 1, 1),  # the node's admins see every open request
        (SUPER, 0, 1, 1),
        (CAROL, 0, 403, 404),  # nobody else sees it ...
        (ADA, 0, 403, 404),
        (OTHER_ADMIN, 0, 403, 404),  # ... including another node's admin
    ],
)
async def test_request_visibility(outbox, admins, actor, mine, node, history):
    session = _chain(BOB)
    await _ask(session)
    user, n = session.users[actor], _node()
    listed = await assistance.list_requests(session, n, user, scope="mine", state="all")
    assert len(listed) == mine
    if node == 403:
        with pytest.raises(HTTPException) as err:
            await assistance.list_requests(session, n, user, scope="node", state="open")
        assert err.value.status_code == 403
    else:
        (queued,) = await assistance.list_requests(session, n, user, scope="node", state="open")
        # The Requests tab: owner, reason, message, age and validation state.
        assert queued.contribution.id == DRAFT and queued.contribution.contributor_name == "Bob"
        assert queued.contribution.can_publish is True
        assert (queued.validation.is_valid, queued.validation.warnings) == (True, 1)
    if history == 404:
        with pytest.raises(HTTPException) as err:
            await assistance.contribution_requests(session, n, user, DRAFT)
        assert err.value.status_code == 404
    else:
        assert len(await assistance.contribution_requests(session, n, user, DRAFT)) == 1


@pytest.mark.asyncio
async def test_withdraw_and_resolve(outbox, admins):
    session = _chain(BOB)
    first = await _ask(session)
    n = _node()
    for actor, status in ((CAROL, 404), (OTHER_ADMIN, 404), (ADMIN, 403)):
        with pytest.raises(HTTPException) as err:
            await assistance.withdraw_request(session, n, session.users[actor], first.id)
        assert err.value.status_code == status
    withdrawn = await assistance.withdraw_request(session, n, session.users[BOB], first.id)
    assert withdrawn.state == "withdrawn"
    # Closed requests leave the admins' queue.
    admin = session.users[ADMIN]
    assert await assistance.list_requests(session, n, admin, scope="node", state="open") == []

    second = await _ask(session, reason="validation")
    note = assistance.ResolveIn(note=" Fixed the lab names; validates now. ")
    with pytest.raises(HTTPException) as err:
        await assistance.resolve_request(session, n, session.users[BOB], second.id, note)
    assert err.value.status_code == 403
    outbox.clear()
    resolved = await assistance.resolve_request(session, n, admin, second.id, note)
    assert (resolved.state, resolved.note, resolved.closed_by_name) == (
        "resolved",
        "Fixed the lab names; validates now.",
        "Admin",
    )
    assert [m["to"] for m in outbox] == ["bob@example.test"]
    assert "Fixed the lab names" in outbox[0]["body"]
    with pytest.raises(HTTPException) as err:
        await assistance.resolve_request(session, n, admin, second.id, note)
    assert err.value.status_code == 409
    # The requester sees how it ended, newest first.
    mine = await assistance.list_requests(session, n, session.users[BOB], scope="mine", state="all")
    assert sorted(r.state for r in mine) == ["resolved", "withdrawn"]
    audit = [(a.operation, a.actor_id) for a in session.added if isinstance(a, AuditEvent)]
    assert audit == [
        ("request-open", BOB),
        ("request-withdraw", BOB),
        ("request-open", BOB),
        ("request-resolve", ADMIN),
    ]


# -- the workspace lists: everyone's own work, node admins included --


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("actor", "listed"),
    [
        (ADA, {42}),  # her draft in her shared workspace
        (CAROL, {42}),  # ... which its editor sees too
        (BOB, {43}),  # his own private draft
        (ADMIN, {44}),  # a node admin lists only their own, not Ada's or Bob's
        (SUPER, set()),
        (OTHER_ADMIN, set()),
    ],
)
async def test_workspace_lists_hold_only_your_own_work(actor, listed):
    session = FakeSession(
        _contribution(),
        others=(
            _contribution(id=43, contributor_id=BOB, workspace_id=None),
            _contribution(id=44, contributor_id=ADMIN, workspace_id=None),
        ),
    )
    out = await private.list_contributions(session, _node(), session.users[actor])
    assert {c.id for c in out} == listed


@pytest.mark.asyncio
async def test_admin_still_opens_a_requested_contribution_not_in_their_lists(outbox, admins):
    session = _chain(BOB)
    await _ask(session)
    admin, n = session.users[ADMIN], _node()
    assert DRAFT not in {c.id for c in await private.list_contributions(session, n, admin)}
    (queued,) = await assistance.list_requests(session, n, admin, scope="node", state="open")
    assert queued.contribution.id == DRAFT
    opened = await private.get_contribution(session, n, admin, DRAFT)
    assert (opened.id, opened.contributor_name, opened.can_publish) == (DRAFT, "Bob", True)
