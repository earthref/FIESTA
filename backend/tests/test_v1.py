"""The legacy /v1 (api.earthref.org) contract, exercised without infrastructure:
the session dependency is a fake and OpenSearch is a stub, so these cover
routing, error shapes, auth, content negotiation and result shaping. The
Postgres/S3 round trip lives in test_phase_m_integration.py."""

import base64
import io
import zipfile
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from fiesta.db.models import Contribution, User
from fiesta.db.session import get_session
from fiesta.nodeconfig import get_deployment
from fiesta.security import hash_password
from fiesta.settings import get_settings

CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"
VALID = (CONFIG_DIR / "magic/seeds/valid.txt").read_text()
INVALID = (CONFIG_DIR / "magic/seeds/invalid.txt").read_text()
PASSWORD = "correct horse"
STAMP = "2026-09-13T00:00:00+00:00"
PASSWORD_HASH = hash_password(PASSWORD)  # bcrypt once, not per test


def basic(username: str, password: str = PASSWORD) -> dict:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


class FakeResult:
    def __init__(self, rows):
        self.rows = list(rows)

    def scalars(self):
        return iter(self.rows)

    def scalar_one_or_none(self):
        return self.rows[0] if self.rows else None

    def all(self):
        return self.rows


class FakeSession:
    """Every `execute` answers with `rows`; `get` looks up `objects` by id."""

    def __init__(self, rows=(), objects=()):
        self.rows = list(rows)
        self.objects = {o.id: o for o in objects}
        self.added = []
        self.commits = 0

    async def execute(self, stmt):
        entity = stmt.column_descriptions[0]["entity"]
        return FakeResult(r for r in self.rows if isinstance(r, entity))

    async def get(self, model, pk):
        return self.objects.get(pk)

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        for i, obj in enumerate(self.added, start=1):
            if getattr(obj, "id", None) is None:
                obj.id = 1000 + i

    async def commit(self):
        await self.flush()
        self.commits += 1


class FakeSearch:
    def __init__(self, hits=(), total=None, healthy=True):
        self.hits = list(hits)
        self.total = len(self.hits) if total is None else total
        self.healthy = healthy
        self.bodies = []

    async def ping(self):
        if isinstance(self.healthy, Exception):
            raise self.healthy
        return self.healthy

    async def search(self, index, body):
        self.bodies.append(body)
        return {"hits": {"total": {"value": self.total}, "hits": self.hits}}


def user(**overrides) -> User:
    fields = {
        "id": 7,
        "email": "ada@example.test",
        "name": "Ada King Lovelace",
        "handle": "ada",
        "orcid": None,
        "password_hash": PASSWORD_HASH,
        "is_admin": False,
    }
    return User(**{**fields, **overrides})


def contribution(**overrides) -> Contribution:
    fields = {
        "id": 42,
        "node": "magic",
        "contributor_id": 7,
        "is_activated": True,
        "is_latest": True,
        "data_model_version": "3.0",
        "head_revision": "rev-1",
        "filename": "magic_contribution_42.txt",
        "version": 1,
        "previous_id": None,
        "workspace_id": None,
        "deleted_at": None,
        "published_revision": "rev-1",
    }
    return Contribution(**{**fields, **overrides})


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("FIESTA_CONFIG_FILE", str(CONFIG_DIR / "fiesta.yaml"))
    monkeypatch.delenv("FIESTA_NODE", raising=False)
    get_settings.cache_clear()
    get_deployment.cache_clear()
    from fiesta.apps.api import create_app
    from fiesta.apps.routers import v1

    application = create_app()
    application.state.session = FakeSession()
    application.dependency_overrides[get_session] = lambda: application.state.session
    application.state.search = FakeSearch()
    monkeypatch.setattr(v1, "get_opensearch", lambda: application.state.search)

    async def no_throttle():
        pass

    monkeypatch.setattr(v1, "_throttle", no_throttle)
    yield application
    get_settings.cache_clear()
    get_deployment.cache_clear()


@pytest.fixture
async def client(app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://api"
    ) as client:
        yield client


# ---- routing, docs and error bodies ---------------------------------------------


async def test_v1_lives_outside_the_v2_schema(app, client):
    assert not [p for p in app.openapi()["paths"] if p.startswith("/v1")]
    yaml = await client.get("/v1/openapi.yaml")
    assert yaml.status_code == 200 and yaml.text.startswith("openapi: 3.0.1")
    assert "/v1/{repository}/private/search/{table}" in yaml.text
    assert (await client.get("/openapi.yaml")).text == yaml.text
    for path in ("/v1", "/v1/", "/v1/index.html"):
        page = await client.get(path)
        assert page.status_code == 200 and "/v1/openapi.yaml" in page.text, path
    root = await client.get("/")
    assert root.status_code in (302, 307) and root.headers["location"] == "/v1"
    assert (await client.get("/v2/docs")).status_code == 200


async def test_unknown_v1_paths_and_methods_use_the_koa_error_body(client):
    unknown = await client.get("/v1/MagIC/nope")
    assert unknown.status_code == 404
    assert unknown.json() == {
        "errors": [
            {
                "message": "Path '/v1/MagIC/nope' is not defined for this API. "
                "See https://api.earthref.org for more information."
            }
        ]
    }
    # openapi-backend answered an undefined method with notFound, not 405.
    assert (await client.post("/v1/MagIC/download")).status_code == 404
    assert (await client.post("/v1/MagIC/private/download")).status_code == 404
    # /v2 keeps FastAPI's shape.
    assert (await client.get("/v2/nope/config")).json()["detail"].startswith("unknown repository")
    assert (await client.post("/v2/health-check")).status_code == 405


async def test_parameter_validation_is_a_400_with_errors(client):
    bad = await client.get("/v1/MagIC/download", params={"id": "1a"})
    assert bad.status_code == 400
    assert bad.json()["errors"][0]["path"] == ["query", "id", "0"]
    assert "message" in bad.json()["errors"][0]
    assert (await client.get("/v1/MagIC/search/contributions?n_max_rows=0")).status_code == 400
    assert (await client.get("/v1/MagIC/private/data?id=0")).status_code == 400
    # An unknown repository is still the legacy 404 body.
    assert (await client.get("/v1/nope/search/contributions")).status_code == 404


async def test_public_download_and_data_preconditions(client):
    missing = await client.get("/v1/MagIC/download")
    assert missing.status_code == 400
    assert missing.json() == {"errors": [{"message": "At least one query parameter is required."}]}
    no_id = await client.get("/v1/MagIC/data")
    assert no_id.status_code == 502
    assert no_id.json()["errors"][0]["message"].endswith("data from a public contribution.")
    keyed = await client.get("/v1/MagIC/data", params={"key": "abc"})
    assert keyed.status_code == 502
    assert "private key" in keyed.json()["errors"][0]["message"]


async def test_health_check_reports_search_only(app, client):
    healthy = await client.get("/v1/health-check", headers={"Accept": "text/plain"})
    assert healthy.status_code == 200 and healthy.json() == {"message": "Healthy!"}
    app.state.search = FakeSearch(healthy=False)
    assert (await client.get("/v1/health-check")).status_code == 500
    app.state.search = FakeSearch(healthy=ConnectionError("down"))
    down = await client.get("/v1/health-check")
    assert down.status_code == 500
    assert down.json() == {"errors": [{"message": "Health has check failed."}]}


# ---- authentication -------------------------------------------------------------------


async def test_authenticate_with_http_basic(app, client):
    app.state.session = FakeSession(rows=[user()])
    anonymous = await client.get("/v1/authenticate")
    assert anonymous.status_code == 401
    assert anonymous.json() == {"errors": [{"message": "Username or password is not recognized."}]}
    wrong = await client.get("/v1/authenticate", headers=basic("ada", "wrong"))
    assert wrong.status_code == 401
    ok = await client.get("/v1/authenticate", headers=basic("ADA"))
    assert ok.status_code == 200, ok.text
    assert ok.json() == {
        "id": 7,
        "handle": "ada",
        "name": {"given": "Ada King", "family": "Lovelace"},
        "email": "ada@example.test",
        "orcid": None,
        "has_password": True,
    }


@pytest.mark.parametrize(
    ("method", "path", "message"),
    [
        ("GET", "/v1/MagIC/private/download?id=1", "Username or password is not recognized"),
        ("GET", "/v1/MagIC/private/data?id=1", "Username or password is not recognized"),
        ("PUT", "/v1/MagIC/private/validate?id=1", "Username or password is not recognized"),
        (
            "GET",
            "/v1/MagIC/private/search/contributions",
            "Username or password is not recognized.",
        ),
        ("POST", "/v1/MagIC/private", "Username or password is not recognized."),
        ("PUT", "/v1/MagIC/private?id=1", "Username or password is not recognized."),
        ("PATCH", "/v1/MagIC/private?id=1", "Username or password is not recognized."),
        ("DELETE", "/v1/MagIC/private?id=1", "Username or password is not recognized."),
    ],
)
async def test_private_routes_require_credentials(app, client, method, path, message):
    anonymous = await client.request(method, path)
    assert anonymous.status_code == 401, anonymous.text
    assert anonymous.json() == {"errors": [{"message": message}]}
    app.state.session = FakeSession(rows=[user()])
    wrong = await client.request(method, path, headers=basic("ada", "nope"))
    assert wrong.status_code == 401, wrong.text


# ---- public search -------------------------------------------------------------------


def contribution_hit(cid: int, **extra) -> dict:
    return {
        "_source": {
            "summary": {
                "contribution": {
                    "id": cid,
                    "version": 1,
                    "timestamp": STAMP,
                    "data_model_version": "3.0",
                    "_contributor": "Ada",
                    "_private_key": "secret",
                    "_is_activated": True,
                    **extra,
                }
            }
        }
    }


async def test_public_search_keeps_the_legacy_page_shape(app, client):
    app.state.session = FakeSession(rows=[contribution(id=42), contribution(id=41)])
    app.state.search = FakeSearch(hits=[contribution_hit(42), contribution_hit(41)], total=2)
    page = await client.get("/v1/MagIC/search/contributions")
    assert page.status_code == 200, page.text
    assert page.json() == {
        "total": 2,
        "table": "contribution",
        "size": 10,
        "from": 0,
        "queries": [],
        "results": [
            {
                "id": 42,
                "version": 1,
                "timestamp": "2026-09-13T00:00:00+00:00",
                "data_model_version": "3.0",
            },
            {
                "id": 41,
                "version": 1,
                "timestamp": "2026-09-13T00:00:00+00:00",
                "data_model_version": "3.0",
            },
        ],
    }
    body = app.state.search.bodies[-1]
    assert body["_source"] == ["summary.contribution", "rows"]
    assert {"term": {"type": "contribution"}} in body["query"]["bool"]["must"]
    assert body["query"]["bool"]["filter"] == [
        {
            "bool": {
                "should": [{"terms": {"summary.contribution.id": [41, 42]}}],
                "minimum_should_match": 1,
            }
        }
    ]

    page = await client.get(
        "/v1/MagIC/search/contributions",
        params=[
            ("n_max_rows", "5"),
            ("from", "3"),
            ("query", "basalt"),
            ("query", "Hawaii"),
            ("included_columns", "lat"),
            ("missing_columns", "age"),
        ],
    )
    assert page.status_code == 200
    assert page.json()["size"] == 5 and page.json()["from"] == 3
    assert page.json()["queries"] == ["basalt", "Hawaii"]
    body = app.state.search.bodies[-1]
    assert body["size"] == 5 and body["from"] == 3
    must = body["query"]["bool"]["must"]
    assert {"query_string": {"query": "basalt", "default_operator": "AND"}} in must
    assert {"query_string": {"query": "Hawaii", "default_operator": "AND"}} in must
    assert {"exists": {"field": "summary._all.lat"}} in must
    assert body["query"]["bool"]["must_not"] == [{"exists": {"field": "summary._all.age"}}]


async def test_public_search_flattens_rows_and_answers_204_when_empty(app, client):
    app.state.session = FakeSession(rows=[contribution(id=42)])
    rows = [{"site": "S1"}, {"site": "S2"}]
    app.state.search = FakeSearch(
        hits=[
            {"_source": {"summary": {"contribution": {"id": 42}}, "rows": rows[:1]}},
            {"_source": {"summary": {"contribution": {"id": 42}}, "rows": rows[1:]}},
        ]
    )
    sites = await client.get("/v1/MagIC/search/sites")
    assert sites.status_code == 200
    assert sites.json()["table"] == "sites" and sites.json()["results"] == rows
    # The legacy `experiments` level is FIESTA's measurement rows.
    await client.get("/v1/MagIC/search/experiments")
    assert {"term": {"type": "measurements"}} in app.state.search.bodies[-1]["query"]["bool"][
        "must"
    ]
    app.state.search = FakeSearch()
    empty = await client.get("/v1/MagIC/search/contributions?query=nothing")
    assert empty.status_code == 204 and empty.content == b""
    assert (await client.get("/v1/MagIC/search")).status_code == 404


# ---- contribution data, downloads and validation --------------------------------------


@pytest.fixture
def stored_text(monkeypatch):
    from fiesta.apps.routers import v1

    async def text(session, node, c):
        return VALID

    monkeypatch.setattr(v1, "contribution_text", text)


async def test_public_data_negotiates_format_and_enforces_private_keys(app, client, stored_text):
    private = contribution(id=43, is_activated=False)
    app.state.session = FakeSession(objects=[contribution(id=42), private])
    text = await client.get("/v1/MagIC/data?id=42")
    assert text.status_code == 200 and text.text == VALID
    assert text.headers["content-type"].startswith("text/plain")
    text = await client.get("/v1/MagIC/data?id=42", headers={"Accept": "text/plain"})
    assert text.text == VALID
    data = await client.get("/v1/MagIC/data?id=42", headers={"Accept": "application/json"})
    assert data.status_code == 200
    assert set(data.json()) >= {"contribution", "locations", "sites"}
    assert data.json()["contribution"][0]["data_model_version"] == "3.0"
    assert (await client.get("/v1/MagIC/data?id=99")).status_code == 204
    # A private contribution needs its private key (legacy skipped this check).
    assert (await client.get("/v1/MagIC/data?id=43")).status_code == 204
    assert (await client.get("/v1/MagIC/data?id=43&key=wrong")).status_code == 204
    shared = await client.get(f"/v1/MagIC/data?id=43&key={private.private_key}")
    assert shared.status_code == 200 and shared.text == VALID


async def test_public_download_zips_the_lineage(app, client, stored_text):
    v1 = contribution(id=40, is_latest=False)
    v2 = contribution(id=44, previous_id=40)
    app.state.session = FakeSession(rows=[v2, v1])
    archive = await client.get("/v1/MagIC/download?id=40")
    assert archive.status_code == 200, archive.text
    assert archive.headers["content-type"] == "application/zip"
    assert archive.headers["content-disposition"].startswith(
        'attachment; filename="MagIC Download - Public - '
    )
    names = zipfile.ZipFile(io.BytesIO(archive.content)).namelist()
    assert names == ["44/magic_contribution_44.txt", "40/magic_contribution_40.txt"]
    only_json = await client.get("/v1/MagIC/download?id=40", headers={"Accept": "application/json"})
    assert zipfile.ZipFile(io.BytesIO(only_json.content)).namelist()[0].endswith(".json")
    # Free-text criteria go through the search projection, ordered as it answers.
    app.state.search = FakeSearch(hits=[contribution_hit(40)])
    archive = await client.get("/v1/MagIC/download?query=basalt&contributor_name=Ada")
    assert zipfile.ZipFile(io.BytesIO(archive.content)).namelist() == [
        "40/magic_contribution_40.txt"
    ]
    must = app.state.search.bodies[-1]["query"]["bool"]["must"]
    assert {"terms": {"summary.contribution._contributor.raw": ["Ada"]}} in must
    app.state.search = FakeSearch()
    assert (await client.get("/v1/MagIC/download?query=nothing")).status_code == 204
    app.state.session = FakeSession()
    assert (await client.get("/v1/MagIC/download?id=1")).status_code == 204


async def test_validate_reports_in_the_legacy_shape(client):
    good = await client.post("/v1/MagIC/validate", files=[("file", ("valid.txt", VALID))])
    assert good.status_code == 200, good.text
    assert good.json()["validation"]["errors"] == []
    bad = await client.post(
        "/v1/MagIC/validate", files=[("file", ("a.txt", VALID)), ("file", ("b.txt", INVALID))]
    )
    assert bad.status_code == 200
    issues = bad.json()["validation"]["errors"]
    assert issues and set(issues[0]) == {"table", "column", "message", "rows"}
    raw = await client.post("/v1/MagIC/validate", content=INVALID.encode())
    assert raw.json()["validation"]["errors"] == issues
    garbage = await client.post("/v1/MagIC/validate", content=b"not a contribution")
    assert garbage.json()["validation"]["errors"][0]["table"] is None


# ---- private workspace ----------------------------------------------------------------


async def test_private_create_search_data_and_delete(app, client, stored_text, monkeypatch):
    from fiesta.apps.routers import v1

    ada = user()
    mine = contribution(id=42, is_activated=False, published_revision=None)
    theirs = contribution(id=43, is_activated=False, contributor_id=8, published_revision=None)
    app.state.session = FakeSession(rows=[ada], objects=[mine, theirs])
    created = await client.post("/v1/MagIC/private", headers=basic("ada"))
    assert created.status_code == 201, created.text
    assert created.json() == {"id": 1001}
    new = app.state.session.added[0]
    assert new.node == "magic" and new.contributor_id == 7 and new.data_model_version == "3.0"

    assert (await client.get("/v1/MagIC/private/data?id=42", headers=basic("ada"))).text == VALID
    assert (
        await client.get("/v1/MagIC/private/data?id=43", headers=basic("ada"))
    ).status_code == 204
    report = await client.put("/v1/MagIC/private/validate?id=42", headers=basic("ada"))
    assert report.status_code == 200 and report.json()["validation"]["errors"] == []

    # Private search filters to the caller's unpublished contributions.
    app.state.session = FakeSession(rows=[ada])
    app.state.search = FakeSearch(hits=[contribution_hit(42, _is_activated=False)])
    page = await client.get("/v1/MagIC/private/search/contributions?query=x", headers=basic("ada"))
    assert page.status_code == 200, page.text
    assert page.json()["exists_fields"] == [] and page.json()["results"][0] == {
        "id": 42,
        "version": 1,
        "timestamp": STAMP,
        "data_model_version": "3.0",
    }
    assert {"query_string": {"query": "x"}} in app.state.search.bodies[-1]["query"]["bool"]["must"]

    deleted = []

    async def delete(session, node, c, *, actor_id):
        deleted.append((c.id, actor_id))

    monkeypatch.setattr(v1.svc, "delete_contribution", delete)
    app.state.session = FakeSession(rows=[ada], objects=[mine, theirs])
    assert (await client.delete("/v1/MagIC/private?id=42", headers=basic("ada"))).json() == {
        "rowsDeleted": 1
    }
    assert (await client.delete("/v1/MagIC/private?id=43", headers=basic("ada"))).json() == {
        "rowsDeleted": 0
    }
    assert (await client.delete("/v1/MagIC/private?id=99", headers=basic("ada"))).json() == {
        "rowsDeleted": 0
    }
    assert deleted == [(42, 7)]


async def test_private_upload_merges_tables_and_saves_a_revision(
    app, client, stored_text, monkeypatch
):
    from fiesta.apps.routers import v1

    ada = user()
    mine = contribution(id=42, is_activated=False, published_revision=None, head_revision="rev-1")
    theirs = contribution(id=43, is_activated=False, contributor_id=8, published_revision=None)
    app.state.session = FakeSession(rows=[ada], objects=[mine, theirs])
    saved = []

    async def save_revision(session, node, c, actor_id, **kwargs):
        saved.append((c.id, actor_id, kwargs))

    monkeypatch.setattr(v1, "save_revision", save_revision)
    sites = "tab delimited\tsites\nsite\tlocation\nNEW-1\tHawaii\nNEW-2\tHawaii\n"
    replaced = await client.put(
        "/v1/MagIC/private?id=42", headers=basic("ada"), files=[("file", ("sites.txt", sites))]
    )
    assert replaced.status_code == 202, replaced.text
    assert replaced.json() == {"id": 42}
    cid, actor, kwargs = saved[-1]
    assert (cid, actor, kwargs["operation"], kwargs["canonical"]) == (
        42,
        7,
        "legacy-replace",
        "magic_contribution_42.txt",
    )
    assert kwargs["expected_revision"] == "rev-1"
    from fiesta.domain.parse import parse_text

    tables = parse_text(kwargs["files"]["magic_contribution_42.txt"].decode()).tables
    assert [r["site"] for r in tables["sites"]] == ["NEW-1", "NEW-2"]
    assert tables["contribution"] == parse_text(VALID).tables["contribution"]
    assert tables["locations"] == parse_text(VALID).tables["locations"]

    appended = await client.patch(
        "/v1/MagIC/private?id=42", headers=basic("ada"), files=[("file", ("sites.txt", sites))]
    )
    assert appended.status_code == 202, appended.text
    assert appended.json() == {"id": 42, "rows_added": 2}
    tables = parse_text(saved[-1][2]["files"]["magic_contribution_42.txt"].decode()).tables
    assert len(tables["sites"]) == len(parse_text(VALID).tables["sites"]) + 2

    other = await client.put(
        "/v1/MagIC/private?id=43", headers=basic("ada"), files=[("file", ("sites.txt", sites))]
    )
    assert other.status_code == 401
    assert other.json()["errors"][0]["message"] == (
        "The contribution with ID 43 is owned by another contributor."
    )
    assert (
        await client.put(
            "/v1/MagIC/private?id=99", headers=basic("ada"), files=[("file", ("s.txt", sites))]
        )
    ).status_code == 204
    empty = await client.put("/v1/MagIC/private?id=42", headers=basic("ada"))
    assert empty.status_code == 400
    garbage = await client.put(
        "/v1/MagIC/private?id=42", headers=basic("ada"), files=[("file", ("g.txt", "no tables"))]
    )
    assert garbage.status_code == 500 and "g.txt" in garbage.json()["errors"][0]["message"]


def test_legacy_validation_groups_rows_per_message():
    from fiesta.apps.routers.v1 import legacy_validation
    from fiesta.domain.validate import Issue, ValidationReport

    report = ValidationReport(
        errors=[
            Issue("sites", 1, "lat", "required"),
            Issue("sites", 3, "lat", "required"),
            Issue("sites", None, "lon", "type"),
        ],
        warnings=[Issue("locations", 2, "age", "cv")],
    )
    assert legacy_validation(report) == {
        "errors": [
            {"table": "sites", "column": "lat", "message": "required", "rows": [1, 3]},
            {"table": "sites", "column": "lon", "message": "type", "rows": []},
        ],
        "warnings": [{"table": "locations", "column": "age", "message": "cv", "rows": [2]}],
    }


def test_accept_format_matches_koa_negotiation():
    from fiesta.apps.routers.v1 import accept_format

    def fmt(accept):
        return accept_format(SimpleNamespace(headers={"accept": accept} if accept else {}))

    assert fmt(None) == "txt"
    assert fmt("*/*") == "txt"
    assert fmt("text/plain") == "txt"
    assert fmt("application/json, text/plain;q=0.5") == "txt"
    assert fmt("application/vnd.ms-excel") == "txt"
    assert fmt("application/json") == "json"
    assert fmt("application/json; charset=utf-8") == "json"
