"""Revision and local-development contracts independent of external services."""

from pathlib import Path

import pytest
from fastapi import HTTPException

from fiesta.domain.parse import parse_text
from fiesta.domain.validate import validate_contribution
from fiesta.nodeconfig import load_deployment
from fiesta.services.revisions import safe_name
from fiesta.services.seed import load_seed, local_file, require_local
from fiesta.settings import Settings


@pytest.mark.parametrize("node", ["magic", "cdr", "karar", "kdd", "erda", "osu-mgr"])
def test_seed_fixtures(node):
    config = Path(__file__).resolve().parents[2] / "config" / f"{node}.yaml"
    node = load_deployment(config).node_list[0]
    root, manifest = load_seed(node)
    for item in manifest["contributions"]:
        if item.get("published"):
            for rev in item["revisions"]:
                raw = local_file(root, rev["files"][rev["canonical"]]).read_text()
                assert validate_contribution(node, parse_text(raw)).is_valid

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
async def test_local_login_uses_seeded_developer(monkeypatch, seeded):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    from fiesta.apps.routers.auth import local_login
    from fiesta.security import decode_access_token
    from fiesta.services import seed

    monkeypatch.setattr(
        seed, "get_settings", lambda: Settings(_env_file=None, environment="development")
    )
    result = Mock()
    result.scalar_one_or_none.return_value = SimpleNamespace(id=123) if seeded else None
    session = AsyncMock()
    session.execute.return_value = result
    token = await local_login(session)
    if seeded:
        assert decode_access_token(token.access_token) == 123
    else:
        assert token is None
