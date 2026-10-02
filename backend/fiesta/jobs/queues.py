"""Procrastinate queue names (no imports, so node config validation can use them).

Every node has a queue named after its slug (contribution processing);
`default` carries email and node-configuration publication; `ops` carries the
scheduled operations jobs (`fiesta.ops`), which only `fiesta ops-worker`
consumes. A node can therefore never be called `default` or `ops`.
"""

from collections.abc import Iterable

DEFAULT_QUEUE = "default"
OPS_QUEUE = "ops"
RESERVED_QUEUES = frozenset({DEFAULT_QUEUE, OPS_QUEUE})


def main_worker_queues(node_slugs: Iterable[str]) -> list[str]:
    """The queues `fiesta worker` listens on: every node's own queue plus
    `default`, never `ops` (an explicit list, because procrastinate's
    queues=None means every queue, `ops` included)."""
    queues = sorted({slug for slug in node_slugs if slug not in RESERVED_QUEUES})
    return [*queues, DEFAULT_QUEUE]
