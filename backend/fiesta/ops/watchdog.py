"""Missed-run watchdog: a schedule with no successful run within its
`expected_interval` is reported, whatever the reason (worker down, job stuck
behind a lock, a run interrupted, deferral skipped after an outage).

It runs as a periodic job in `fiesta ops-worker` and as `fiesta ops-watchdog
--post` from another host's timer, which is what notices a dead ops worker.
Neither keeps state: an overdue schedule is reported on the check that falls
in the first `tick` seconds after its deadline and again every `realert`, so
a restart neither loses nor repeats an alert.

A schedule with no run ever recorded in this database is not watched (the
ops worker has not started against it yet); `fiesta ops-status` shows it.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

from fiesta.ops.config import OpsConfig, Schedule
from fiesta.ops.history import ScheduleState

logger = logging.getLogger(__name__)


@dataclass
class Overdue:
    schedule: Schedule
    state: ScheduleState
    deadline: datetime


def deadline_for(schedule: Schedule, state: ScheduleState | None) -> datetime | None:
    """When the schedule becomes overdue: its last success (or, never having
    succeeded, its first recorded run) plus expected_interval."""
    if state is None:
        return None
    base = state.last_success_at or state.first_seen_at
    if base is None:
        return None
    return base + timedelta(seconds=schedule.expected_interval)


def find_overdue(
    config: OpsConfig, states: dict[str, ScheduleState], now: datetime
) -> list[Overdue]:
    overdue = []
    for schedule in config.enabled_schedules:
        state = states.get(schedule.name)
        deadline = deadline_for(schedule, state)
        if deadline is not None and now >= deadline:
            overdue.append(Overdue(schedule, state, deadline))
    return overdue


def should_alert(now: datetime, deadline: datetime, *, tick: float, realert: float) -> bool:
    """True on the one check per `realert` period that falls within `tick`
    seconds of the deadline (or of deadline + n * realert). tick <= 0 means
    every check alerts (a one-off manual run)."""
    since = (now - deadline).total_seconds()
    if since < 0:
        return False
    if tick <= 0:
        return True
    return since % realert < tick
