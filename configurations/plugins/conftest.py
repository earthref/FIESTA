"""Fixtures for the plugins' own tests (`<name>/test_<name>.py`), collected by
the backend suite (fiesta/backend/pyproject.toml testpaths):
`cd fiesta/backend && uv run pytest`."""

import os
from pathlib import Path

import pytest

from fiesta.nodeconfig import load_deployment

CONFIG_DIR = Path(__file__).resolve().parents[1]

os.environ.setdefault("FIESTA_NODE_CONFIG_SOURCE", "files")
os.environ.setdefault("FIESTA_PLUGINS_DIR", str(CONFIG_DIR / "plugins"))


def _node(slug: str):
    return load_deployment(CONFIG_DIR / f"{slug}.yaml").node_for(slug)


@pytest.fixture(scope="session")
def magic_node():
    return _node("magic")
