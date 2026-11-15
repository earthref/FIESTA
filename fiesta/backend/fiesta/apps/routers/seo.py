"""What crawlers and language models read: server-rendered page heads and
bodies, robots.txt, sitemaps and llms.txt.

The SPA renders in the browser, so a crawler that runs no JavaScript (most AI
crawlers) would see an empty shell. The shell's `index.html` asks the web
server for two fragments by server-side include (nginx SSI, see
fiesta/frontend/nginx.conf.template and docs/deployment.md):

- `GET /v2/seo/head/<path>?<query>`: the page's <title>, description,
  canonical link, Open Graph tags and JSON-LD (a contribution's schema.org
  Dataset, a node home's DataCatalog), plus `noindex` off the canonical host;
- `GET /v2/seo/body/<path>?<query>`: a plain reading of the page inside the
  SPA's root element (React replaces it on start): a contribution's summary, a
  content page's text, a node's links.

`<path>` is the SPA path as requested (`/MagIC/20907`, `/MagIC/search?contribution=20907`,
`/MagIC/about`); the node is its first segment. Only public, activated
contributions are described. Both answer 200 with a node's default when the
path names nothing they know, so the shell always renders.

Plain files beside them: `/v2/robots.txt`, `/v2/llms.txt` (every node), and per
node `/v2/{node}/sitemap.xml` (home, search, pages, every public
contribution) and `/v2/{node}/llms.txt`; the web server serves them at
`/robots.txt`, `/llms.txt`, `/<Key>/sitemap.xml` and `/<Key>/llms.txt`.
"""

import html
import json
import logging
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from sqlalchemy import func, select

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.apps.public_urls import api_base, catalog_url, indexable, site_url
from fiesta.apps.routers.search import _contribution_doc, contribution_dataset
from fiesta.db.models import Contribution
from fiesta.db.session import get_sessionmaker
from fiesta.domain.jsonld import _text, catalog_jsonld
from fiesta.nodeconfig import NodeConfig, get_deployment

log = logging.getLogger(__name__)

router = APIRouter(tags=["seo"])  # /v2
node_router = APIRouter(tags=["seo"])  # /v2/{repository}

API_DOCS = "https://github.com/earthref/FIESTA/blob/main/docs/api.md"
# One sitemap holds at most 50,000 URLs (sitemaps.org).
MAX_SITEMAP_URLS = 50_000
# SPA routes no crawler should index.
PRIVATE_ROUTES = ("account", "admin", "login", "private", "upload", "upgrade", "validate")


def _web_nodes() -> list[NodeConfig]:
    return [n for n in get_deployment().node_list if n.serves_web]


def _node_named(segment: str) -> NodeConfig | None:
    wanted = segment.lower()
    return next(
        (n for n in _web_nodes() if wanted in (n.node.key.lower(), n.node.slug.lower())), None
    )


@dataclass
class Target:
    """What an SPA path shows."""

    node: NodeConfig | None
    kind: str  # portal | home | search | contribution | page | private | other
    contribution_id: int | None = None
    page: str | None = None


def resolve(path: str, query: dict[str, str]) -> Target:
    segments = [s for s in path.split("/") if s]
    node = _node_named(segments[0]) if segments else None
    if node is None:
        return Target(None, "portal" if not segments else "other")
    rest = segments[1:]
    cid = query.get("contribution", "")
    if cid.isdigit():
        return Target(node, "contribution", int(cid))
    if not rest:
        return Target(node, "home")
    if len(rest) == 1 and rest[0].isdigit():
        return Target(node, "contribution", int(rest[0]))
    if len(rest) == 2 and rest[0] == "contributions" and rest[1].isdigit():
        return Target(node, "contribution", int(rest[1]))
    if rest == ["search"]:
        return Target(node, "search")
    if rest[0] in PRIVATE_ROUTES:
        return Target(node, "private")
    if len(rest) == 1 and node.page(rest[0]):
        return Target(node, "page", page=rest[0])
    return Target(node, "other")


@dataclass
class Described:
    """A page as crawlers are told about it."""

    title: str
    description: str
    canonical: str | None = None
    jsonld: dict | None = None
    index: bool = True
    body: str = ""


def _esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


class _TextOf(HTMLParser):
    """The readable text of an HTML page, one paragraph per block."""

    BLOCKS = {"p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "section"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in ("script", "style", "template"):
            self.skip += 1
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style", "template"):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)

    def paragraphs(self) -> list[str]:
        text = "".join(self.parts)
        return [" ".join(p.split()) for p in text.split("\n") if p.strip()]


def page_paragraphs(raw_html: str) -> list[str]:
    parser = _TextOf()
    parser.feed(raw_html)
    return parser.paragraphs()


def _links(items: list[tuple[str, str]]) -> str:
    return (
        "<ul>" + "".join(f'<li><a href="{_esc(u)}">{_esc(t)}</a></li>' for t, u in items) + "</ul>"
    )


def _node_links(node: NodeConfig) -> list[tuple[str, str]]:
    catalog = catalog_url(node)
    return [(f"Search {node.node.key}", f"{catalog}/search")] + [
        (page.title, f"{catalog}/{page.slug}") for page in node.pages if page.menu != "hidden"
    ]


def _dataset_body(data: dict) -> str:
    """A contribution's Dataset as a page: what the modal shows, in brief."""
    parts = [f"<h1>{_esc(data['name'])}</h1>", f"<p>{_esc(data.get('description', ''))}</p>"]
    facts = []
    if ident := data.get("identifier"):
        facts.append(("DOI", f'<a href="{_esc(ident["url"])}">{_esc(ident["value"])}</a>'))
    if version := data.get("version"):
        facts.append(("Version", _esc(version)))
    if modified := data.get("dateModified"):
        facts.append(("Updated", _esc(str(modified)[:10])))
    if article := data.get("citation"):
        cite = _esc(article.get("description") or article.get("name", ""))
        facts.append(
            (
                "Reference",
                f'<a href="{_esc(article["url"])}">{cite}</a>' if article.get("url") else cite,
            )
        )
    if creators := data.get("creator"):
        facts.append(("Authors", _esc(", ".join(c["name"] for c in creators))))
    if dist := data.get("distribution"):
        facts.append(
            ("Data", f'<a href="{_esc(dist["contentUrl"])}">Download (tab-delimited text)</a>')
        )
    facts.append(("License", f'<a href="{_esc(data["license"])}">{_esc(data["license"])}</a>'))
    parts.append("<dl>" + "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in facts) + "</dl>")
    if keywords := data.get("keywords"):
        parts.append(f"<h2>Keywords</h2><p>{_esc(', '.join(keywords))}</p>")
    if techniques := data.get("measurementTechnique"):
        items = "".join(f"<li>{_esc(t['termCode'])}: {_esc(t['name'])}</li>" for t in techniques)
        parts.append(f"<h2>Methods</h2><ul>{items}</ul>")
    if variables := data.get("variableMeasured"):

        def variable(v: dict) -> str:
            unit = f" ({_esc(v['unitText'])})" if v.get("unitText") else ""
            return (
                f"<li>{_esc(v['name'])}{unit}: {_esc(v['minValue'])} to {_esc(v['maxValue'])}</li>"
            )

        items = "".join(variable(v) for v in variables)
        parts.append(f"<h2>Measured variables</h2><ul>{items}</ul>")
    return "".join(parts)


async def _contribution(node: NodeConfig, cid: int) -> Contribution | None:
    async with get_sessionmaker(node.node.slug)() as session:
        contribution = await session.get(Contribution, cid)
    if (
        contribution is None
        or contribution.node != node.node.slug
        or contribution.deleted_at is not None
        or not contribution.is_activated
    ):
        return None
    return contribution


async def _public_count(node: NodeConfig) -> int | None:
    try:
        async with get_sessionmaker(node.node.slug)() as session:
            return await session.scalar(
                select(func.count()).select_from(Contribution).where(*_public(node))
            )
    except Exception:  # a count is a nicety; never fail a page for it
        log.exception("seo: counting %s contributions", node.node.slug)
        return None


def _public(node: NodeConfig) -> tuple:
    return (
        Contribution.node == node.node.slug,
        Contribution.is_activated.is_(True),
        Contribution.is_latest.is_(True),
        Contribution.deleted_at.is_(None),
    )


async def describe(request: Request, target: Target) -> Described:
    node = target.node
    if node is None:
        names = ", ".join(n.node.key for n in _web_nodes())
        return Described(
            title="EarthRef.org",
            description=f"EarthRef.org data repositories: {names}.",
            canonical=f"{site_url()}/",
            body=_links([(n.node.title, catalog_url(n)) for n in _web_nodes()]),
        )
    identity = node.node
    catalog = catalog_url(node)
    default = Described(
        title=identity.title,
        description=_text(identity.subtitle) or identity.title,
        body=f"<h1>{_esc(identity.title)}</h1><p>{_esc(_text(identity.subtitle))}</p>"
        + _links(_node_links(node)),
    )
    if target.kind == "home":
        count = await _public_count(node)
        data = catalog_jsonld(node, catalog_url=catalog, contributions=count)
        default.canonical = catalog
        default.jsonld = data
        default.description = data["description"]
        return default
    if target.kind == "search":
        default.title = f"Search {identity.key} — {identity.title}"
        default.canonical = f"{catalog}/search"
        return default
    if target.kind == "page" and target.page:
        page = node.page(target.page)
        paragraphs = page_paragraphs(node.load_page_html(target.page))
        return Described(
            title=f"{page.title} — {identity.title}",
            description=(" ".join(paragraphs)[:300] or default.description),
            canonical=f"{catalog}/{target.page}",
            body=f"<h1>{_esc(page.title)}</h1>" + "".join(f"<p>{_esc(p)}</p>" for p in paragraphs),
        )
    if target.kind == "contribution" and target.contribution_id is not None:
        contribution = await _contribution(node, target.contribution_id)
        if contribution is not None:
            try:
                doc = await _contribution_doc(node, contribution)
            except Exception:  # not indexed yet, or the index is down
                doc = None
            if doc is not None:
                data = contribution_dataset(request, node, contribution, doc)
                return Described(
                    title=f"{data['name']} — {identity.key}",
                    description=data["description"][:300],
                    canonical=data["url"],
                    jsonld=data,
                    body=_dataset_body(data),
                )
        default.index = False  # private, deleted or unknown: say nothing
        return default
    if target.kind == "private":
        default.index = False
    return default


def _head(d: Described, request: Request, node: NodeConfig | None) -> str:
    tags = [
        f"<title>{_esc(d.title)}</title>",
        f'<meta name="description" content="{_esc(d.description)}" />',
        f'<meta property="og:title" content="{_esc(d.title)}" />',
        f'<meta property="og:description" content="{_esc(d.description)}" />',
        '<meta property="og:type" content="website" />',
    ]
    if node is not None:
        tags.append(f'<meta property="og:site_name" content="{_esc(node.node.key)}" />')
    if d.canonical:
        tags += [
            f'<link rel="canonical" href="{_esc(d.canonical)}" />',
            f'<meta property="og:url" content="{_esc(d.canonical)}" />',
        ]
    if not (d.index and indexable(request)):
        tags.append('<meta name="robots" content="noindex" />')
    if d.jsonld:
        # "</" would end the script element early.
        payload = json.dumps(d.jsonld, ensure_ascii=False).replace("</", "<\\/")
        tags.append(f'<script type="application/ld+json">{payload}</script>')
    return "\n    ".join(tags)


def _query(request: Request) -> dict[str, str]:
    return {k: v for k, v in request.query_params.items()}


@router.get("/seo/head/{path:path}", response_class=HTMLResponse, include_in_schema=False)
@router.get("/seo/head", response_class=HTMLResponse, include_in_schema=False)
async def seo_head(request: Request, path: str = "") -> HTMLResponse:
    target = resolve(path, _query(request))
    described = await describe(request, target)
    return HTMLResponse(_head(described, request, target.node))


@router.get("/seo/body/{path:path}", response_class=HTMLResponse, include_in_schema=False)
@router.get("/seo/body", response_class=HTMLResponse, include_in_schema=False)
async def seo_body(request: Request, path: str = "") -> HTMLResponse:
    target = resolve(path, _query(request))
    described = await describe(request, target)
    return HTMLResponse(f'<div class="fiesta-prerender">{described.body}</div>')


@router.get("/robots.txt", response_class=PlainTextResponse, include_in_schema=False)
async def robots(request: Request) -> PlainTextResponse:
    if not indexable(request):
        return PlainTextResponse(
            "# A copy of the EarthRef.org site: not for indexing.\nUser-agent: *\nDisallow: /\n"
        )
    lines = [
        "# EarthRef.org. Search engines and AI crawlers are welcome: every",
        "# public contribution page carries schema.org Dataset JSON-LD.",
        "User-agent: *",
        "Allow: /",
    ]
    for node in _web_nodes():
        key = node.node.key
        lines += [f"Disallow: /{key}/{route}" for route in PRIVATE_ROUTES]
    # The API stays open: JSON-LD names its downloads there.
    lines.append("")
    lines += [f"Sitemap: {catalog_url(node)}/sitemap.xml" for node in _web_nodes()]
    return PlainTextResponse("\n".join(lines) + "\n")


@router.get("/llms.txt", response_class=PlainTextResponse, include_in_schema=False)
async def llms_index() -> PlainTextResponse:
    lines = [
        "# EarthRef.org",
        "",
        "> Open, versioned geoscience data repositories (paleomagnetism, rock",
        "> magnetism, geochronology, geochemistry, cores and samples) run on the",
        "> FIESTA platform. Every repository below has its own llms.txt.",
        "",
        "## Repositories",
        "",
    ]
    for node in _web_nodes():
        subtitle = _text(node.node.subtitle)
        lines.append(
            f"- [{node.node.title}]({catalog_url(node)}/llms.txt)"
            + (f": {subtitle}" if subtitle else "")
        )
    lines += ["", "## Optional", "", f"- [FIESTA API reference]({API_DOCS})"]
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/markdown")


@node_router.get("/llms.txt", response_class=PlainTextResponse, include_in_schema=False)
async def llms_node(request: Request, node: NodeDep) -> PlainTextResponse:
    identity = node.node
    catalog = catalog_url(node)
    api = f"{api_base(request)}/{identity.slug}"
    count = await _public_count(node)
    levels = [lvl.name.lower() for lvl in node.search.levels if lvl.table != "contribution"]
    subtitle = _text(identity.subtitle)
    about = (
        (identity.title if identity.key in identity.title else f"{identity.title} ({identity.key})")
        + " is an open data repository at EarthRef.org"
        + (f" holding {count:,} public contributions" if count is not None else "")
        + ". A contribution is one dataset, usually the data behind a paper, versioned and"
        + (f" organized as {', '.join(levels)}" if levels else "")
        + f". Data are free to use under {node.jsonld.license}."
        + f" Each contribution has a page at {catalog}/<id> that carries schema.org"
        + " Dataset JSON-LD, and its data file downloads as tab-delimited text."
    )
    lines = [f"# {identity.title}", ""]
    if subtitle:
        lines += [f"> {subtitle}", ""]
    lines += [
        about,
        "",
        "## Data access",
        "",
        f"- [Search {identity.key}]({catalog}/search): full-text and faceted search of the"
        " contributions and their records",
        f"- [Sitemap]({catalog}/sitemap.xml): every public contribution page",
        f"- [Search API]({api}/search/contribution?q=example&size=10): JSON search results"
        f" (`/search/<level>?q=…`; levels: {', '.join(lvl.table for lvl in node.search.levels)})",
        f"- Contribution API: `{api}/contributions/<id>` (summary),"
        f" `{api}/contributions/<id>/download` (data file),"
        f" `{api}/contributions/<id>/jsonld` (schema.org Dataset)",
        f"- [API reference]({API_DOCS}): every route and its parameters",
        f"- [Data model {node.data_model.latest}]({catalog}/data-models/{node.data_model.latest}):"
        " tables, columns, units and vocabularies",
    ]
    pages = [p for p in node.pages if p.menu != "hidden"]
    if pages:
        lines += ["", "## Pages", ""]
        lines += [f"- [{p.title}]({catalog}/{p.slug})" for p in pages]
    optional = []
    if (website := identity.links.website) and website.rstrip("/") != catalog:
        optional.append(f"- [Website]({website})")
    if issues := identity.links.github_issues:
        optional.append(f"- [Report an issue]({issues})")
    if optional:
        lines += ["", "## Optional", "", *optional]
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/markdown")


@node_router.get("/sitemap.xml", include_in_schema=False)
async def sitemap(session: SessionDep, node: NodeDep) -> Response:
    catalog = catalog_url(node)
    urls: list[tuple[str, str | None]] = [(catalog, None), (f"{catalog}/search", None)]
    urls += [(f"{catalog}/{p.slug}", None) for p in node.pages if p.menu != "hidden"]
    rows = await session.execute(
        select(Contribution.id, Contribution.updated_at)
        .where(*_public(node))
        .order_by(Contribution.id)
        .limit(MAX_SITEMAP_URLS - len(urls))
    )
    urls += [
        (f"{catalog}/{cid}", updated.date().isoformat() if updated else None)
        for cid, updated in rows
    ]
    body = "".join(
        f"<url><loc>{_esc(loc)}</loc>" + (f"<lastmod>{mod}</lastmod>" if mod else "") + "</url>\n"
        for loc, mod in urls
    )
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{body}</urlset>\n"
    )
    return Response(xml, media_type="application/xml")
