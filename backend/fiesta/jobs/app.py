"""Procrastinate application (Postgres-native job queue, LISTEN/NOTIFY)."""

from functools import lru_cache

import procrastinate

from fiesta.settings import get_settings


@lru_cache
def get_job_app() -> procrastinate.App:
    app = procrastinate.App(
        connector=procrastinate.PsycopgConnector(conninfo=get_settings().procrastinate_dsn),
        import_paths=["fiesta.jobs.tasks"],
    )
    return app
