import os
from pathlib import Path

import pytest

from fiesta.nodeconfig import Deployment, load_deployment

CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"

# Tests read node configuration from config/ (and fake their sessions); the
# Postgres-backed node configuration has its own tests that switch it on.
os.environ.setdefault("FIESTA_NODE_CONFIG_SOURCE", "files")


@pytest.fixture(scope="session")
def magic_deployment() -> Deployment:
    return load_deployment(CONFIG_DIR / "magic.yaml")


@pytest.fixture(scope="session")
def magic_node(magic_deployment):
    return magic_deployment.node_for("magic")


@pytest.fixture(scope="session")
def karar_node():
    return load_deployment(CONFIG_DIR / "karar.yaml").node_for("karar")


@pytest.fixture(scope="session")
def erda_node():
    return load_deployment(CONFIG_DIR / "erda.yaml").node_for("erda")


@pytest.fixture(scope="session")
def osu_mgr_node():
    return load_deployment(CONFIG_DIR / "osu-mgr.yaml").node_for("osu-mgr")
