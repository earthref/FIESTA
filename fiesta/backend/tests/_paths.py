"""Where the tests find this checkout's node configuration."""

from pathlib import Path

# configurations/ at the repo root; the integration test image mounts it at /config.
CONFIG_DIR = next(
    (
        p / "configurations"
        for p in Path(__file__).resolve().parents
        if (p / "configurations").is_dir()
    ),
    Path("/config"),
)
