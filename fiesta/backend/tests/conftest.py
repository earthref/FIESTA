import os

import pytest
from _paths import CONFIG_DIR

from fiesta.nodeconfig import Deployment, load_deployment

# Tests read node configuration from configurations/ (and fake their sessions); the
# Postgres-backed node configuration has its own tests that switch it on.
os.environ.setdefault("FIESTA_NODE_CONFIG_SOURCE", "files")
# configurations/fiesta.yaml mirrors data sources until the cutover; tests contribute.
os.environ.setdefault("FIESTA_CONTRIBUTIONS_MODE", "public")
# The plugins stay this checkout's even where a test points FIESTA_CONFIG_FILE
# at a temporary copy of a node's tree.
os.environ.setdefault("FIESTA_PLUGINS_DIR", str(CONFIG_DIR / "plugins"))


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


@pytest.fixture(scope="session")
def sc_node():
    return load_deployment(CONFIG_DIR / "sc.yaml").node_for("sc")
