"""The schedules file (`config/ops/schedules.yaml`): one entry per job.

    fiesta-ops: 1
    slack:
      channel: C0123456789          # channel ID; the bot token is FIESTA_SLACK_BOT_TOKEN
    watchdog:
      cron: "*/15 * * * *"          # how often missed runs are checked (UTC)
      realert: 24h                  # repeat a missed-run alert this often while it lasts
    schedules:
      - name: osu-mgr-incremental
        node: osu-mgr               # optional; omitted = a global job
        cron: "0 10 * * *"          # UTC
        command: [.venv/bin/python, osu_mgr_pipeline.py, --incremental, --since, 72h]
        cwd: /srv/osu-mgr-pipeline
        env_file: null              # optional dotenv merged into the environment
        timeout: 2h
        notify: both                # success | failure | both
        expected_interval: 26h      # missed-run watchdog threshold

A job is either `command` (an argv list, run without a shell) or `callable`
(a dotted path, `package.module:function` or `package.module.function`, sync
or async, called with `kwargs`). Durations are seconds or `1d2h30m15s` forms.
"""

import re
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from croniter import croniter
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from fiesta.settings import get_settings

_DURATION_PART = re.compile(r"(\d+(?:\.\d+)?)([dhms])")
_UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}
_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def parse_duration(value: Any) -> float:
    """Seconds from a number or a `1d2h30m15s`-style string."""
    if isinstance(value, bool):
        raise ValueError(f"invalid duration {value!r}")
    if isinstance(value, int | float):
        seconds = float(value)
    elif isinstance(value, str):
        text = value.strip().lower().replace(" ", "")
        if re.fullmatch(r"\d+(\.\d+)?", text):
            seconds = float(text)
        else:
            parts = _DURATION_PART.findall(text)
            if not parts or "".join(n + u for n, u in parts) != text:
                raise ValueError(f"invalid duration {value!r} (e.g. 90, 45s, 30m, 2h, 1d)")
            seconds = sum(float(n) * _UNITS[u] for n, u in parts)
    else:
        raise ValueError(f"invalid duration {value!r}")
    if seconds <= 0:
        raise ValueError(f"duration {value!r} must be positive")
    return seconds


def cron_max_gap(cron: str, samples: int = 400) -> float:
    """The longest gap in seconds between consecutive firings of `cron` over
    `samples` firings from a fixed date (so monthly/weekday crons count)."""
    it = croniter(cron, datetime(2026, 1, 1, tzinfo=UTC))
    previous = it.get_next(float)
    gap = 0.0
    for _ in range(samples):
        current = it.get_next(float)
        gap = max(gap, current - previous)
        previous = current
    return gap


def _validate_cron(value: str) -> str:
    value = " ".join(value.split())
    if not croniter.is_valid(value):
        raise ValueError(f"invalid cron expression {value!r}")
    return value


class SlackConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Channel ID (C...), not its name: chat.postMessage accepts either, but an
    # ID survives a rename. Empty: messages are logged instead of posted.
    channel: str = ""


class WatchdogConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cron: str = "*/15 * * * *"
    realert: float = 24 * 3600

    @field_validator("cron")
    @classmethod
    def _cron(cls, value: str) -> str:
        return _validate_cron(value)

    @field_validator("realert", mode="before")
    @classmethod
    def _duration(cls, value):
        return parse_duration(value)

    @property
    def tick(self) -> float:
        """Seconds between watchdog checks (the alert window)."""
        return cron_max_gap(self.cron, samples=8)


class Schedule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str = ""
    node: str | None = None
    enabled: bool = True
    cron: str
    command: list[str] | None = None
    cwd: str | None = None
    env_file: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    callable: str | None = None
    kwargs: dict[str, Any] = Field(default_factory=dict)
    timeout: float = 3600
    lock: str | None = None
    notify: Literal["success", "failure", "both"] = "both"
    expected_interval: float
    # Fields of the run's JSON summary shown in the success message; empty
    # shows every scalar top-level field (up to eight).
    summary_keys: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not _NAME.match(value):
            raise ValueError(
                f"schedule name {value!r}: lowercase letters, digits and hyphens, "
                "starting with a letter or digit"
            )
        return value

    @field_validator("cron")
    @classmethod
    def _cron(cls, value: str) -> str:
        return _validate_cron(value)

    @field_validator("timeout", "expected_interval", mode="before")
    @classmethod
    def _duration(cls, value):
        return parse_duration(value)

    @field_validator("command")
    @classmethod
    def _command(cls, value):
        if value is not None and (not value or not all(isinstance(a, str) and a for a in value)):
            raise ValueError("command must be a non-empty list of non-empty strings")
        return value

    @field_validator("callable")
    @classmethod
    def _callable(cls, value):
        if value is not None and not re.fullmatch(r"[A-Za-z_][\w.]*(:[A-Za-z_]\w*)?", value):
            raise ValueError(f"callable {value!r}: a dotted path, `package.module:function`")
        if value is not None and ":" not in value and "." not in value:
            raise ValueError(f"callable {value!r}: needs a module, `package.module:function`")
        return value

    @model_validator(mode="after")
    def _target(self):
        if (self.command is None) == (self.callable is None):
            raise ValueError(f"schedule {self.name!r}: give exactly one of `command`, `callable`")
        if self.callable is not None and (self.cwd or self.env_file or self.env):
            raise ValueError(
                f"schedule {self.name!r}: `cwd`, `env_file`, `env` apply to `command` only"
            )
        if self.command is not None and self.kwargs:
            raise ValueError(f"schedule {self.name!r}: `kwargs` apply to `callable` only")
        gap = cron_max_gap(self.cron)
        if self.expected_interval <= gap:
            raise ValueError(
                f"schedule {self.name!r}: expected_interval ({self.expected_interval:.0f}s) "
                f"must exceed the longest gap between runs of {self.cron!r} ({gap:.0f}s), "
                "or the watchdog would always fire"
            )
        return self

    @property
    def lock_key(self) -> str:
        """procrastinate `lock` (no two runs at once) and `queueing_lock` (at
        most one waiting) for this schedule."""
        return self.lock or f"ops:{self.name}"

    @property
    def label(self) -> str:
        return f"{self.name} [{self.node}]" if self.node else self.name


class OpsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: Literal[1] = Field(alias="fiesta-ops")
    slack: SlackConfig = Field(default_factory=SlackConfig)
    watchdog: WatchdogConfig = Field(default_factory=WatchdogConfig)
    schedules: list[Schedule] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique(self):
        names = [s.name for s in self.schedules]
        if dupes := sorted({n for n in names if names.count(n) > 1}):
            raise ValueError(f"duplicate schedule names: {dupes}")
        return self

    @property
    def enabled_schedules(self) -> list[Schedule]:
        return [s for s in self.schedules if s.enabled]

    def schedule(self, name: str) -> Schedule:
        for s in self.schedules:
            if s.name == name:
                return s
        raise KeyError(f"no schedule named {name!r}")

    def unknown_nodes(self, node_slugs: set[str]) -> list[str]:
        """Schedules whose `node` is not one of node_slugs."""
        return [s.name for s in self.schedules if s.node and s.node not in node_slugs]


def ops_config_path() -> Path:
    settings = get_settings()
    if settings.ops_config_file:
        return Path(settings.ops_config_file).resolve()
    return (settings.config_file.resolve().parent / "ops" / "schedules.yaml").resolve()


def parse_ops_config(text: str) -> OpsConfig:
    raw = yaml.safe_load(text) or {}
    if not isinstance(raw, dict):
        raise ValueError("the schedules file must be a mapping")
    return OpsConfig.model_validate(raw)


def load_ops_config(path: Path | None = None) -> OpsConfig:
    path = path or ops_config_path()
    try:
        return parse_ops_config(path.read_text())
    except (ValueError, yaml.YAMLError) as exc:
        raise ValueError(f"{path}: {exc}") from exc


@lru_cache
def get_ops_config() -> OpsConfig:
    return load_ops_config()
