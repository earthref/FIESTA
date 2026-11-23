from functools import lru_cache

from opensearchpy import AsyncOpenSearch

from fiesta.settings import get_settings


@lru_cache
def get_opensearch() -> AsyncOpenSearch:
    """Scheme and credentials come from the URL (opensearch-py parses
    https://user:pass@host:port into use_ssl + http_auth)."""
    settings = get_settings()
    return AsyncOpenSearch(
        hosts=[settings.opensearch_url],
        verify_certs=settings.opensearch_verify_certs,
        ca_certs=settings.opensearch_ca_certs,
        # gzip both ways: map points and exports pull MBs of hits, and the
        # cluster can be a WAN hop from the API (AWS from fiesta-ct).
        http_compress=True,
    )
