from functools import lru_cache

from opensearchpy import AsyncOpenSearch

from fiesta.settings import get_settings


@lru_cache
def get_opensearch() -> AsyncOpenSearch:
    return AsyncOpenSearch(hosts=[get_settings().opensearch_url], use_ssl=False)
