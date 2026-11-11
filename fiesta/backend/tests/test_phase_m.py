"""Revision and local-development contracts independent of external services."""

import pytest
from _paths import CONFIG_DIR
from fastapi import HTTPException

from fiesta.domain.parse import parse_text
from fiesta.domain.validate import validate_contribution
from fiesta.nodeconfig import load_deployment
from fiesta.services.revisions import safe_name
from fiesta.services.seed import load_seed, local_file, require_local
from fiesta.settings import Settings

DEPLOYMENT = CONFIG_DIR / "fiesta.yaml"


@pytest.mark.parametrize("node", ["magic", "cdr", "karar", "kdd", "erda", "osu-mgr", "sc"])
def test_seed_fixtures(node):
    config = CONFIG_DIR / f"{node}.yaml"
    node = load_deployment(config).node_list[0]
    root, manifest = load_seed(node)
    for item in manifest["contributions"]:
        if item.get("published"):
            for rev in item["revisions"]:
                raw = local_file(root, rev["files"][rev["canonical"]]).read_text()
                assert validate_contribution(node, parse_text(raw)).is_valid

    accounts = {account["email"]: account for account in manifest["accounts"]}
    assert accounts["developer@example.test"].get("admin"), "the local developer is a super admin"
    assert not accounts["viewer@example.test"].get("admin")

    items = {item["key"]: item for item in manifest["contributions"]}
    assert not items["draft"].get("published")
    for key in ("typical-1", "typical-2", "all-fields"):
        assert items[key]["published"]
        assert not items[key].get("previous"), "examples must be independent public contributions"
    step = items["all-fields"]["revisions"][-1]
    parsed = parse_text(local_file(root, step["files"][step["canonical"]]).read_text())
    model = node.load_data_model(node.data_model.latest)
    assert set(parsed.tables) == set(model["tables"])
    for table, definition in model["tables"].items():
        populated = {key for row in parsed.tables[table] for key, value in row.items() if value}
        assert populated == set(definition["columns"]), f"missing populated fields in {table}"


def test_magic_seed_poles(magic_node):
    from fiesta.plugins.poles import PolesPlugin

    root, manifest = load_seed(magic_node)
    poles = [item for item in manifest["contributions"] if item["key"].startswith("poles-")]
    assert len(poles) >= 2
    ages = set()
    for item in poles:
        assert item["published"]
        step = item["revisions"][-1]
        parsed = parse_text(local_file(root, step["files"][step["canonical"]]).read_text())
        docs = PolesPlugin().derive_docs(magic_node, parsed, {"id": 1})
        assert docs and all(doc["type"] == "poles" for doc in docs)
        for doc in docs:
            assert doc["summary"]["_all"]["_geo_point"]
            assert doc["summary"]["poles"]["pole_alpha95"] > 0
            ages.add(doc["summary"]["poles"]["age"])
    assert len(ages) >= 2


@pytest.mark.parametrize(
    "setting,value",
    [
        ("environment", "production"),
        ("database_url", "postgresql://user@marfik/fiesta"),
        ("database_url", "postgresql://user@localhost/db?host=marfik"),
        ("opensearch_url", "https://marfik:9200"),
        ("s3_endpoint", None),
        ("s3_endpoint", "https://s3.amazonaws.com"),
    ],
)
def test_seed_refuses_remote_settings(setting, value):
    settings = Settings(_env_file=None, environment="development")
    with pytest.raises(ValueError):
        require_local(settings.model_copy(update={setting: value}))


def test_local_seed_guard():
    require_local(Settings(_env_file=None, environment="development"))


@pytest.mark.parametrize("name", ["../file", "a/b", "a\\b", "", "a\nheader"])
def test_revision_names_reject_paths(name):
    with pytest.raises(HTTPException):
        safe_name(name)


def test_fixture_paths_cannot_escape(tmp_path):
    with pytest.raises(ValueError):
        local_file(tmp_path, "../secret")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        {"environment": "production"},
        {"database_url": "postgresql://user@marfik/fiesta"},
        {"opensearch_url": "https://marfik:9200"},
        {"s3_endpoint": None},
    ],
)
async def test_local_login_refuses_nonlocal_environments(monkeypatch, overrides):
    from unittest.mock import AsyncMock

    from fiesta.apps.routers.auth import local_login
    from fiesta.services import seed

    settings = Settings(_env_file=None, environment="development").model_copy(update=overrides)
    monkeypatch.setattr(seed, "get_settings", lambda: settings)
    session = AsyncMock()
    assert await local_login(session) is None
    session.execute.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("seeded", [False, True])
async def test_local_login_signs_in_developer(monkeypatch, seeded):
    """Local login signs in Local Developer, creating the manifest's accounts first
    on a stack `make seed` has not touched."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    from fiesta import nodeconfig
    from fiesta.apps.routers.auth import local_login
    from fiesta.security import decode_access_token
    from fiesta.services import seed

    monkeypatch.setattr(
        seed, "get_settings", lambda: Settings(_env_file=None, environment="development")
    )
    monkeypatch.setattr(nodeconfig, "get_deployment", lambda: load_deployment(DEPLOYMENT))
    created = []

    async def ensure_accounts(session, manifest):
        created.extend(account["email"] for account in manifest["accounts"])

    monkeypatch.setattr(seed, "ensure_accounts", ensure_accounts)

    def result(user):
        value = Mock()
        value.scalar_one_or_none.return_value = user
        return value

    developer = SimpleNamespace(id=123)
    session = AsyncMock()
    lookups = [result(developer)] if seeded else [result(None), result(developer)]
    session.execute.side_effect = lookups
    token = await local_login(session)
    assert decode_access_token(token.access_token) == 123
    if seeded:
        assert not created and not session.commit.called
    else:
        assert {"developer@example.test", "viewer@example.test"} <= set(created)
        session.commit.assert_awaited_once()


def _account(**fields):
    from fiesta.db.models import User
    from fiesta.security import hash_password

    defaults = {"id": 7, "email": "old@example.org", "name": "Old Name", "settings": {}}
    defaults["is_admin"] = False
    defaults["password_hash"] = hash_password("old-password")
    return User(**{**defaults, **fields})


def _modes(monkeypatch, *modes):
    from types import SimpleNamespace

    from fiesta.apps.routers import auth

    nodes = [
        SimpleNamespace(node=SimpleNamespace(key=f"N{i}"), contributions_mode=mode)
        for i, mode in enumerate(modes)
    ]
    monkeypatch.setattr(auth, "get_deployment", lambda: SimpleNamespace(node_list=nodes))

    async def unique(*args, **kwargs):
        return None

    monkeypatch.setattr(auth, "ensure_unique_user_fields", unique)


@pytest.mark.asyncio
async def test_account_edits_own_fields(monkeypatch):
    from unittest.mock import AsyncMock

    from fiesta.apps.routers.auth import update_me
    from fiesta.apps.schemas import AccountPatchIn

    _modes(monkeypatch, "public")
    user = _account(handle="old", orcid="0000-0002-1825-0097")
    payload = AccountPatchIn(name=" New Name ", email="New@Example.org", handle="", orcid=None)
    out = await update_me(payload, user, AsyncMock())
    assert (out.name, out.email, out.handle, out.orcid) == (
        "New Name",
        "new@example.org",
        None,
        None,
    )
    assert out.has_password


@pytest.mark.asyncio
async def test_account_email_change_refused_while_a_node_syncs(monkeypatch):
    from unittest.mock import AsyncMock

    from fiesta.apps.routers.auth import update_me
    from fiesta.apps.schemas import AccountPatchIn

    _modes(monkeypatch, "public", "source")
    user = _account()
    with pytest.raises(HTTPException) as err:
        await update_me(AccountPatchIn(email="new@example.org"), user, AsyncMock())
    assert err.value.status_code == 409 and "N1" in err.value.detail
    # The unchanged address (any case) and the other fields still save.
    payload = AccountPatchIn(email="OLD@example.org", name="Renamed")
    out = await update_me(payload, user, AsyncMock())
    assert (out.email, out.name) == ("old@example.org", "Renamed")


@pytest.mark.parametrize(
    "fields", [{"handle": "a@b"}, {"handle": "x"}, {"orcid": "1234"}, {"name": ""}]
)
def test_account_patch_rejects_bad_fields(fields):
    from pydantic import ValidationError

    from fiesta.apps.schemas import AccountPatchIn

    with pytest.raises(ValidationError):
        AccountPatchIn(**fields)


@pytest.mark.asyncio
async def test_account_password_change():
    from unittest.mock import AsyncMock

    from fiesta.apps.routers.auth import change_password
    from fiesta.apps.schemas import PasswordIn
    from fiesta.security import verify_password

    user = _account()
    with pytest.raises(HTTPException) as err:
        await change_password(PasswordIn(new_password="new-password"), user, AsyncMock())
    assert err.value.status_code == 403
    payload = PasswordIn(current_password="old-password", new_password="new-password")
    await change_password(payload, user, AsyncMock())
    assert verify_password("new-password", user.password_hash)
    # An account imported without a password sets one without a current password.
    imported = _account(password_hash=None)
    await change_password(PasswordIn(new_password="first-password"), imported, AsyncMock())
    assert verify_password("first-password", imported.password_hash)
