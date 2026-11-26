"""Responses built from a search index, reused until the index changes.

Every write that changes what a search sees (a contribution's docs indexed,
deleted or re-flagged, a rebuild) ends in a refresh, from whichever process
made it (the worker, the API, a CLI drain). So the index's own counters are
the one version every process shares: its concrete name (a rebuild swaps the
alias), its primaries' index and delete totals and its external refreshes.
An entry is served only while they are unchanged, so it is never older than
the index it was built from.
"""

import logging
import time
from collections import OrderedDict

from opensearchpy import AsyncOpenSearch
from opensearchpy.exceptions import AuthorizationException, NotFoundError, TransportError

logger = logging.getLogger(__name__)

# One stats call vouches for an index this long (how stale a hit may be).
TOKEN_TTL = 2.0
# Without index stats (a role refused indices:monitor/stats), entries expire instead.
FALLBACK_TTL = 60.0
STATS_FILTER = (
    "indices.*.primaries.indexing.index_total,"
    "indices.*.primaries.indexing.delete_total,"
    "indices.*.primaries.refresh.external_total"
)


class IndexCache:
    """An LRU of response bytes per key, bounded by their total size."""

    def __init__(self, max_bytes: int):
        self.max_bytes = max_bytes
        self._entries: OrderedDict[tuple, tuple[str | None, float, bytes]] = OrderedDict()
        self._bytes = 0
        self._tokens: dict[str, tuple[float, str | None]] = {}
        self._stats_refused = False

    async def token(self, client: AsyncOpenSearch, index: str) -> str | None:
        """The index's current version, or None when it cannot be read."""
        now = time.monotonic()
        held = self._tokens.get(index)
        if held and now - held[0] < TOKEN_TTL:
            return held[1]
        token = None
        if not self._stats_refused:
            try:
                stats = await client.indices.stats(
                    index=index, metric="indexing,refresh", filter_path=STATS_FILTER
                )
                token = repr(sorted((stats.get("indices") or {}).items()))
            except AuthorizationException:
                self._stats_refused = True
                logger.warning(
                    "index stats refused (indices:monitor/stats); cached map points "
                    "expire after %ss instead of on index changes",
                    FALLBACK_TTL,
                )
            except NotFoundError:
                token = "missing"
            except TransportError as exc:
                logger.warning("could not read index stats: %s", exc)
        self._tokens[index] = (now, token)
        return token

    def get(self, key: tuple, token: str | None) -> bytes | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        held, built, body = entry
        fresh = held == token if token is not None else time.monotonic() - built < FALLBACK_TTL
        if not fresh:
            self._drop(key)
            return None
        self._entries.move_to_end(key)
        return body

    def put(self, key: tuple, token: str | None, body: bytes) -> None:
        if len(body) > self.max_bytes:
            return
        self._drop(key)
        self._entries[key] = (token, time.monotonic(), body)
        self._bytes += len(body)
        while self._bytes > self.max_bytes:
            self._drop(next(iter(self._entries)))

    def _drop(self, key: tuple) -> None:
        entry = self._entries.pop(key, None)
        if entry is not None:
            self._bytes -= len(entry[2])
