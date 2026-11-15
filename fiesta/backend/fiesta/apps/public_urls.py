"""Public URLs of the web app and API as a crawler sees them.

The canonical site is `api.site_url` (fiesta.yaml, https://earthref.org): a
node's pages live at `<site_url>/<Key>/` and those are the URLs JSON-LD,
canonical links, sitemaps and llms.txt name, whichever host served them. A
request from another host (dev.earthref.org, localhost) is a copy of the
site: it is not to be indexed.

API links (downloads, the OpenAPI schema) follow the proxy in front of the
API: it forwards `X-Forwarded-Prefix` (the SPA's base path, `/MagIC/` or `/`)
and the API is at `<prefix>v2/` on the requesting host; without the header,
the API's own base URL.
"""

from urllib.parse import urlsplit

from fastapi import Request

from fiesta.nodeconfig import NodeConfig, get_deployment


def site_url() -> str:
    return get_deployment().site_url.rstrip("/")


def catalog_url(node: NodeConfig) -> str:
    """The node's home page: `https://earthref.org/MagIC`."""
    return f"{site_url()}/{node.node.key}"


def request_host(request: Request) -> str:
    """The host the visitor asked for (behind the proxy), without a port."""
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    return host.split(",")[0].strip().split(":")[0].lower()


def indexable(request: Request) -> bool:
    """Served from the canonical site's host (not a dev or local copy)."""
    return request_host(request) == (urlsplit(site_url()).hostname or "").lower()


def api_base(request: Request) -> str:
    """The public API root, ending in /v2: `https://earthref.org/MagIC/v2`."""
    prefix = request.headers.get("x-forwarded-prefix")
    if prefix is None:
        return f"{str(request.base_url).rstrip('/')}/v2"
    if indexable(request):
        origin = site_url().removesuffix(urlsplit(site_url()).path)
    else:
        proto = request.headers.get("x-forwarded-proto") or request.url.scheme
        port = request.headers.get("host", "").partition(":")[2]
        origin = f"{proto}://{request_host(request)}{':' + port if port else ''}"
    base = prefix.strip("/")
    return f"{origin}/{base}/v2" if base else f"{origin}/v2"
