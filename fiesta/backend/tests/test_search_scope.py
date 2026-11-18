"""The search page's "My contributions" (`mine`) and "Previous versions"
(`versions`) filters, exercised without infrastructure: the session is a fake
holding the Postgres rows, and OpenSearch is a stub that applies the search
body's filter clauses to a handful of docs, so these check what each caller
can actually get back."""

import uuid

import httpx
import pytest
from _paths import CONFIG_DIR

from fiesta.db.models import Contribution, User
from fiesta.db.session import get_session
from fiesta.nodeconfig import get_deployment
from fiesta.security import create_access_token
from fiesta.settings import get_settings

ADA, BOB = 7, 8


class FakeResult:
    def __init__(self, rows):
        self.rows = list(rows)

    def scalars(self):
        return iter(self.rows)


class FakeSession:
    def __init__(self, contributions, users):
        self.contributions = contributions
        self.users = {u.id: u for u in users}

    async def execute(self, stmt):
        return FakeResult(self.contributions)

    async def scalars(self, stmt):
        return iter(self.contributions)

    async def get(self, model, pk):
        return self.users.get(pk) if model is User else None


def _value(doc: dict, path: str):
    for part in path.removesuffix(".raw").split("."):
        doc = doc.get(part) if isinstance(doc, dict) else None
    return doc


def _matches(doc: dict, clause: dict) -> bool:
    (kind, spec), *_ = clause.items()
    if kind == "term":
        (field, value), *_ = spec.items()
        return _value(doc, field) == value
    if kind == "terms":
        (field, values), *_ = spec.items()
        return _value(doc, field) in values
    if kind == "match_none":
        return False
    if kind == "bool":
        should = spec.get("should")
        return all(_matches(doc, c) for c in spec.get("filter", [])) and (
            not should or any(_matches(doc, c) for c in should)
        )
    raise AssertionError(f"unexpected clause {clause}")


class FakeSearch:
    """Answers a search with the docs its filters keep."""

    def __init__(self, docs):
        self.docs = docs

    async def search(self, index, body, **_):
        query = body["query"]["bool"]
        assert not query["must"]
        hits = [d for d in self.docs if all(_matches(d, c) for c in query["filter"])]
        return {"hits": {"total": {"value": len(hits)}, "hits": [{"_source": d} for d in hits]}}


def contribution(id, contributor, activated, latest=True) -> Contribution:
    return Contribution(
        id=id,
        node="magic",
        contributor_id=contributor,
        is_activated=activated,
        is_latest=latest,
        private_key=uuid.uuid4(),
        workspace_id=None,
        deleted_at=None,
    )


def doc(c: Contribution, contributor_id: int | None = None) -> dict:
    return {
        "type": "contribution",
        "summary": {
            "contribution": {
                "id": c.id,
                "_contributor_id": contributor_id or c.contributor_id,
                "_private_key": str(c.private_key),
                "_is_activated": c.is_activated,
                "_is_latest": c.is_latest,
            }
        },
    }


CONTRIBUTIONS = [
    contribution(1, ADA, activated=True),
    contribution(2, ADA, activated=False),
    contribution(3, BOB, activated=False),
    contribution(4, BOB, activated=True),
    contribution(5, BOB, activated=True, latest=False),  # an older version of 4
]


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("FIESTA_CONFIG_FILE", str(CONFIG_DIR / "fiesta.yaml"))
    monkeypatch.delenv("FIESTA_NODE", raising=False)
    get_settings.cache_clear()
    get_deployment.cache_clear()
    from fiesta.apps.api import create_app
    from fiesta.apps.routers import search

    application = create_app()
    users = [
        User(id=ADA, email="ada@example.test", name="Ada", is_admin=False),
        # A super admin: may see every contribution, yet "mine" is still Bob's own.
        User(id=BOB, email="bob@example.test", name="Bob", is_admin=True),
    ]
    session = FakeSession(CONTRIBUTIONS, users)
    application.dependency_overrides[get_session] = lambda: session
    application.state.search = FakeSearch([doc(c) for c in CONTRIBUTIONS])
    monkeypatch.setattr(search, "get_opensearch", lambda: application.state.search)
    yield application
    get_settings.cache_clear()
    get_deployment.cache_clear()


@pytest.fixture
async def client(app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://api"
    ) as client:
        yield client


def as_user(user_id: int) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


async def found(client, headers=None, **params) -> set[int]:
    response = await client.get("/v2/magic/search/contribution", params=params, headers=headers)
    assert response.status_code == 200, response.text
    page = response.json()
    ids = {r["summary"]["contribution"]["id"] for r in page["results"]}
    assert page["total"] == len(ids)
    return ids


async def test_default_search_is_latest_published(client):
    assert await found(client) == {1, 4}
    # Signed in changes nothing without `mine`.
    assert await found(client, as_user(ADA)) == {1, 4}


async def test_previous_versions_add_older_published_versions_only(client):
    assert await found(client, versions="all") == {1, 4, 5}
    assert await found(client, versions="latest") == {1, 4}
    # Still never an unpublished contribution.
    assert await found(client, as_user(ADA), versions="all") == {1, 4, 5}


async def test_anonymous_requests_cannot_use_mine(client):
    for mine in ("in_prep", "published"):
        response = await client.get("/v2/magic/search/contribution", params={"mine": mine})
        assert response.status_code == 401
    # Nor an expired or forged token: anonymous, so refused.
    bad = {"Authorization": "Bearer not-a-token"}
    response = await client.get(
        "/v2/magic/search/contribution", params={"mine": "in_prep"}, headers=bad
    )
    assert response.status_code == 401
    # Yet that token still searches what is public.
    assert await found(client, bad) == {1, 4}
    response = await client.get("/v2/magic/search/contribution", params={"mine": "drafts"})
    assert response.status_code == 422


async def test_mine_is_only_the_signed_in_users_own(client):
    assert await found(client, as_user(ADA), mine="in_prep") == {2}
    assert await found(client, as_user(ADA), mine="published") == {1}
    # An admin's "mine" is theirs too, never another user's in-prep work.
    assert await found(client, as_user(BOB), mine="in_prep") == {3}
    assert await found(client, as_user(BOB), mine="published") == {4}
    assert await found(client, as_user(BOB), mine="published", versions="all") == {4, 5}


async def test_another_users_in_prep_never_appears_even_from_a_stale_doc(app, client):
    """Postgres decides: a doc of Bob's in-prep contribution 3 that claims to
    be Ada's (a stale projection) still is not visible to her."""
    app.state.search.docs = [doc(c, ADA if c.id == 3 else None) for c in CONTRIBUTIONS]
    assert await found(client, as_user(ADA), mine="in_prep") == {2}
    # A client-supplied contributor token does not unlock anything either.
    params = {"mine": "in_prep", "query": f'contributor:"{BOB}"'}
    response = await client.get(
        "/v2/magic/search/contribution", params=params, headers=as_user(ADA)
    )
    assert response.json()["total"] == 0


def site_doc(c: Contribution) -> dict:
    """A sites doc of contribution `c`: one site whose citation is "This study"."""
    block = doc(c)["summary"]["contribution"] | {"reference": f"10.1/{c.id}"}
    return {
        "type": "sites",
        "summary": {"contribution": block},
        "rows": [{"site": f"s{c.id}", "lat": 1.5, "citations": "This study:Other 2001"}],
    }


async def test_download_results_rows_are_the_visible_matches(app, client):
    """Download Results' rows: each chosen level's visible matches as one
    table, "This study" naming the contribution's reference."""
    app.state.search.docs = [site_doc(c) for c in CONTRIBUTIONS]
    url = "/v2/magic/search/contribution/download"
    response = await client.get(url, params={"tables": "sites", "format": "json"})
    assert response.status_code == 200, response.text
    assert "attachment" in response.headers["content-disposition"]
    tables = response.json()
    assert tables["contribution"][0]["data_model_version"]
    assert tables["sites"] == [
        {"site": "s1", "lat": "1.5", "citations": "10.1/1:Other 2001"},
        {"site": "s4", "lat": "1.5", "citations": "10.1/4:Other 2001"},
    ]
    # The node's text format, a block per table.
    text = (await client.get(url, params={"tables": "sites"})).text
    assert text.startswith("tab delimited\tcontribution\n")
    assert "tab delimited\tsites\n" in text
    # Ada's own in-prep rows with `mine`, never anyone's anonymously.
    params = {"tables": "sites", "format": "json", "mine": "in_prep"}
    mine = await client.get(url, params=params, headers=as_user(ADA))
    assert [r["site"] for r in mine.json()["sites"]] == ["s2"]
    assert (await client.get(url, params=params)).status_code == 401
    # A level is required, and only search levels below the contribution.
    for bad in ({}, {"tables": "contribution"}, {"tables": "nonsense"}):
        assert (await client.get(url, params=bad)).status_code == 422


async def test_download_results_files_zip_the_visible_contributions(app, client, monkeypatch):
    import io
    import zipfile

    from fiesta.services import downloads

    async def served(session, node, c):
        data = f"tab delimited\tcontribution\nid\n{c.id}\n".encode()
        return downloads.ServedFile(c.filename, data, downloads.sha256(data), None)

    monkeypatch.setattr(downloads, "served_file", served)
    url = "/v2/magic/search/contribution/download"
    response = await client.get(url, params={"files": True})
    assert response.status_code == 200, response.text
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    names = ["1/magic_contribution_1.txt", "4/magic_contribution_4.txt"]
    assert sorted(archive.namelist()) == [*names, "SHA256SUMS"]
    # SHA256SUMS lists every member's checksum (sha256sum -c lines).
    sums = archive.read("SHA256SUMS").decode().splitlines()
    assert sorted(sums) == sorted(f"{downloads.sha256(archive.read(n))}  {n}" for n in names)
    response = await client.get(url, params={"files": True, "format": "json"})
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert archive.read("1/magic_contribution_1.json").startswith(b'{\n  "contribution"')
