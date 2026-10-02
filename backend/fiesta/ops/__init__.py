"""Scheduled operations: sync jobs and background tasks declared in
`config/ops/schedules.yaml`, deferred by procrastinate periodic tasks on the
`ops` queue and run by `fiesta ops-worker`, with status posted to Slack.
See docs/ops-scheduler.md."""
