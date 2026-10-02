"""Run history from procrastinate's own tables (procrastinate_jobs and
procrastinate_events): no table of our own. A run is one job of RUN_TASK
whose args carry the schedule `name`; its start and finish come from the
`started` and the final event."""

from dataclasses import dataclass
from datetime import datetime

import psycopg
from psycopg.rows import dict_row

from fiesta.settings import get_settings

RUN_TASK = "fiesta.ops.run_schedule"
WATCHDOG_TASK = "fiesta.ops.watchdog"

_STATE_SQL = """
WITH runs AS (
    SELECT j.id, j.args->>'name' AS name, j.status::text AS status,
           coalesce(j.args->>'trigger', 'cron') AS trigger,
           ev.deferred_at, ev.started_at, ev.finished_at
      FROM procrastinate_jobs j
      LEFT JOIN LATERAL (
          SELECT min(e.at) FILTER (WHERE e.type = 'deferred') AS deferred_at,
                 max(e.at) FILTER (WHERE e.type = 'started') AS started_at,
                 max(e.at) FILTER (
                     WHERE e.type IN ('succeeded', 'failed', 'aborted', 'cancelled')
                 ) AS finished_at
            FROM procrastinate_events e
           WHERE e.job_id = j.id
      ) ev ON true
     WHERE j.task_name = %(task)s
)
SELECT DISTINCT ON (name)
       name, id, status, trigger, deferred_at, started_at, finished_at,
       (SELECT max(s.finished_at) FROM runs s
         WHERE s.name = runs.name AND s.status = 'succeeded') AS last_success_at,
       (SELECT min(coalesce(f.deferred_at, f.started_at)) FROM runs f
         WHERE f.name = runs.name) AS first_seen_at
  FROM runs
 WHERE name IS NOT NULL
 ORDER BY name, id DESC
"""


@dataclass
class ScheduleState:
    """The latest run of one schedule plus what the watchdog needs."""

    name: str
    job_id: int
    status: str  # procrastinate status of the latest run: todo|doing|succeeded|failed|...
    trigger: str
    deferred_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    last_success_at: datetime | None
    first_seen_at: datetime | None

    @property
    def duration(self) -> float | None:
        if self.started_at and self.finished_at:
            return (self.finished_at - self.started_at).total_seconds()
        return None


async def schedule_states(dsn: str | None = None) -> dict[str, ScheduleState]:
    async with await psycopg.AsyncConnection.connect(
        dsn or get_settings().procrastinate_dsn, row_factory=dict_row
    ) as conn:
        rows = await (await conn.execute(_STATE_SQL, {"task": RUN_TASK})).fetchall()
    return {
        row["name"]: ScheduleState(
            name=row["name"],
            job_id=row["id"],
            status=row["status"],
            trigger=row["trigger"],
            deferred_at=row["deferred_at"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            last_success_at=row["last_success_at"],
            first_seen_at=row["first_seen_at"],
        )
        for row in rows
    }
