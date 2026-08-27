from pathlib import Path

import pytest

from fiesta.nodeconfig import Deployment, load_deployment

CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"


@pytest.fixture(scope="session")
def magic_deployment() -> Deployment:
    return load_deployment(CONFIG_DIR / "magic.yaml")


@pytest.fixture(scope="session")
def magic_node(magic_deployment):
    return magic_deployment.node


@pytest.fixture(scope="session")
def karar_node():
    return load_deployment(CONFIG_DIR / "karar.yaml").node


@pytest.fixture(scope="session")
def erda_node():
    return load_deployment(CONFIG_DIR / "erda.yaml").node


@pytest.fixture(scope="session")
def osu_mgr_node():
    return load_deployment(CONFIG_DIR / "osu-mgr.yaml").node
