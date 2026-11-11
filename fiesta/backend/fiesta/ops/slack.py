"""Slack status messages (chat.postMessage with a bot token).

Posting never raises: a Slack outage or a bad token is logged and the job's
own outcome stands. With no token or no channel the message is logged instead.
"""

import json
import logging
import socket
from datetime import UTC, datetime
from typing import Any

import httpx

from fiesta.ops.config import Schedule, SlackConfig
from fiesta.ops.runner import RunResult
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)

POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage"
MAX_SUMMARY_FIELDS = 8
MAX_LINE = 300
MAX_TAIL_CHARS = 3500


class SlackNotifier:
    def __init__(
        self, token: str, channel: str, *, transport: httpx.AsyncBaseTransport | None = None
    ):
        self.token = token
        self.channel = channel
        self._transport = transport

    @classmethod
    def from_config(cls, slack: SlackConfig) -> "SlackNotifier":
        return cls(get_settings().slack_bot_token, slack.channel)

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.channel)

    async def post(self, text: str, *, thread_ts: str | None = None) -> str | None:
        """Post `text`; returns the message ts (for a threaded reply), or None
        when not posted."""
        if not self.enabled:
            logger.info("slack (not configured): %s", text)
            return None
        payload: dict[str, Any] = {
            "channel": self.channel,
            "text": text,
            "unfurl_links": False,
            "unfurl_media": False,
        }
        if thread_ts:
            payload["thread_ts"] = thread_ts
        try:
            async with httpx.AsyncClient(timeout=15, transport=self._transport) as client:
                response = await client.post(
                    POST_MESSAGE_URL,
                    json=payload,
                    headers={"Authorization": f"Bearer {self.token}"},
                )
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("slack post failed (%s): %s", exc, text)
            return None
        if not body.get("ok"):
            logger.warning("slack post rejected (%s): %s", body.get("error"), text)
            return None
        return body.get("ts")


def host_label() -> str:
    return socket.gethostname().split(".")[0]


def format_duration(seconds: float) -> str:
    seconds = int(round(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def format_summary(summary: dict[str, Any] | None, keys: list[str] | None = None) -> str:
    """`key: value` pairs from a run's JSON summary: the listed keys, or
    every scalar top-level field (up to MAX_SUMMARY_FIELDS)."""
    if not summary:
        return ""
    if keys:
        items = [(k, summary[k]) for k in keys if k in summary]
    else:
        items = [
            (k, v) for k, v in summary.items() if isinstance(v, str | int | float | bool | None)
        ][:MAX_SUMMARY_FIELDS]
    parts = []
    for key, value in items:
        text = value if isinstance(value, str) else _json_scalar(value)
        if len(text) > 80:
            text = text[:77] + "..."
        parts.append(f"{key}: {text}")
    return ", ".join(parts)


def _json_scalar(value: Any) -> str:
    return json.dumps(value, default=str)


def _trigger_note(trigger: str) -> str:
    return "" if trigger == "cron" else f" ({trigger})"


def format_success(
    schedule: Schedule, result: RunResult, *, host: str, trigger: str = "cron"
) -> str:
    text = (
        f"✅ *{schedule.label}* succeeded in "
        f"{format_duration(result.duration)} on {host}{_trigger_note(trigger)}"
    )
    if summary := format_summary(result.summary, schedule.summary_keys):
        text += f"\n{summary}"
    return text


def format_failure(
    schedule: Schedule, result: RunResult, *, host: str, trigger: str = "cron"
) -> str:
    if result.timed_out:
        what = f"timed out after {format_duration(schedule.timeout)}"
    else:
        what = f"failed ({result.reason}) after {format_duration(result.duration)}"
    text = f"❌ *{schedule.label}* {what} on {host}{_trigger_note(trigger)}"
    if summary := format_summary(result.summary, schedule.summary_keys):
        text += f"\n{summary}"
    if result.tail:
        text += f"\nLast {len(result.tail)} log lines in the thread."
    return text


def format_tail(lines: list[str]) -> str:
    """The log tail as a code block that fits one Slack message."""
    clipped = [line if len(line) <= MAX_LINE else line[: MAX_LINE - 3] + "..." for line in lines]
    body = "\n".join(clipped).replace("```", "'''")
    if len(body) > MAX_TAIL_CHARS:
        body = "...\n" + body[-MAX_TAIL_CHARS:]
    return f"```\n{body}\n```"


def format_interrupted(schedule: Schedule, *, host: str, detail: str) -> str:
    return f"❌ *{schedule.label}* interrupted on {host}: {detail}"


def _utc(moment: datetime | None) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC") if moment else "never"


def format_missed(
    schedule: Schedule,
    *,
    last_success_at: datetime | None,
    last_status: str | None,
    last_started_at: datetime | None,
    host: str,
) -> str:
    interval = format_duration(schedule.expected_interval)
    text = (
        f"❌ *{schedule.label}* missed: no successful run since "
        f"{_utc(last_success_at)} (expected within {interval}; watchdog on {host})"
    )
    if last_status:
        text += f"\nLast run: {last_status}, started {_utc(last_started_at)}."
    else:
        text += "\nNo run has started. Is `fiesta ops-worker` running?"
    return text
