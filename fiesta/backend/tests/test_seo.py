"""Crawler-facing routes (fiesta.apps.routers.seo): SSI heads and bodies,
robots.txt, llms.txt and sitemaps, against the real node YAMLs with the
database and index faked."""

import json
import re
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from _paths import CONFIG_DIR
from test_domain import MAGIC_TEXT

from fiesta.db.session import get_session
from fiesta.domain.parse import parse_text
from fiesta.domain.summarize import summarize
from fiesta.nodeconfig import get_deployment
from fiesta.settings import get_settings

CANONICAL = {"Host": "earthref.org", "X-Forwarded-Prefix": "/MagIC/"}


class FakeSession:
    async def execute(self, statement):
        return [(7, datetime(2026, 1, 2, tzinfo=UTC)), (9, None)]


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("FIESTA_CONFIG_FILE", str(CONFIG_DIR / "fiesta.yaml"))
    monkeypatch.delenv("FIESTA_NODE", raising=False)
    get_settings.cache_clear()
    get_deployment.cache_clear()
    from fiesta.apps.api import create_app
    from fiesta.apps.routers import seo

    application = create_app()
    application.dependency_overrides[get_session] = lambda: FakeSession()

    async def count(node):
        return 1234

    contribution = SimpleNamespace(
        id=12345, node="magic", filename="magic.txt", is_activated=True, deleted_at=None
    )

    async def find(node, cid):
        return contribution if cid == 12345 else None

    meta = {
        "id": 12345,
        "version": 1,
        "_private_key": "secret-key",
        "_is_activated": True,
        # Decodes to a literal "</script>" in the name.
        "_reference": {"title": "Hawaiian &lt;/script&gt; lavas", "doi": "10.1029/93JB00024"},
    }
    doc = next(
        d
        for d in summarize(get_deployment().node_for("magic"), parse_text(MAGIC_TEXT), meta)
        if d["type"] == "contribution"
    )

    async def contribution_doc(node, found):
        return doc

    monkeypatch.setattr(seo, "_public_count", count)
    monkeypatch.setattr(seo, "_contribution", find)
    monkeypatch.setattr(seo, "_contribution_doc", contribution_doc)
    yield application
    get_settings.cache_clear()
    get_deployment.cache_clear()


@pytest.fixture
async def client(app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://api"
    ) as client:
        yield client


def test_resolve_spa_paths(magic_node):
    from fiesta.apps.routers.seo import resolve

    assert resolve("", {}).kind == "portal"
    assert resolve("/MagIC/", {}).kind == "home"
    assert resolve("/magic/search", {}).kind == "search"
    assert resolve("/MagIC/20907", {}).contribution_id == 20907
    assert resolve("/MagIC/contributions/5", {}).contribution_id == 5
    assert resolve("/MagIC/search", {"contribution": "42"}).contribution_id == 42
    assert resolve("/MagIC/about", {}).page == "about"
    assert resolve("/MagIC/private", {}).kind == "private"
    assert resolve("/MagIC/nope", {}).kind == "other"
    assert resolve("/Nowhere/1", {}).node is None


def test_page_paragraphs_drop_markup_and_scripts():
    from fiesta.apps.routers.seo import page_paragraphs

    raw = "<h2>About</h2><p>One <b>two</b></p><script>evil()</script><ul><li>three</li></ul>"
    assert page_paragraphs(raw) == ["About", "One two", "three"]


async def test_contribution_head_carries_its_dataset(client):
    response = await client.get("/v2/seo/head/MagIC/12345", headers=CANONICAL)
    assert response.status_code == 200
    head = response.text
    assert '<link rel="canonical" href="https://earthref.org/MagIC/12345" />' in head
    assert "noindex" not in head
    # The title's "</script>" can neither close the JSON-LD nor the <title>.
    assert "Hawaiian &lt;/script&gt; lavas" in head
    assert head.count("</script>") == 1
    payload = re.search(r'<script type="application/ld\+json">(.*)</script>', head).group(1)
    data = json.loads(payload)
    assert data["@type"] == "Dataset"
    assert data["distribution"]["contentUrl"] == (
        "https://earthref.org/MagIC/v2/magic/contributions/12345/download"
    )
    assert "secret-key" not in head


async def test_search_modal_path_is_the_contribution(client):
    head = (
        await client.get("/v2/seo/head/MagIC/search?contribution=12345", headers=CANONICAL)
    ).text
    assert 'href="https://earthref.org/MagIC/12345"' in head


async def test_unknown_or_private_contribution_says_nothing(client):
    head = (await client.get("/v2/seo/head/MagIC/999", headers=CANONICAL)).text
    assert '<meta name="robots" content="noindex" />' in head
    assert "ld+json" not in head


async def test_off_the_canonical_host_nothing_is_indexed(client):
    head = (await client.get("/v2/seo/head/MagIC/12345", headers={"Host": "dev.earthref.org"})).text
    assert '<meta name="robots" content="noindex" />' in head
    robots = (await client.get("/v2/robots.txt", headers={"Host": "dev.earthref.org"})).text
    assert "Disallow: /\n" in robots


async def test_home_is_a_data_catalog(client):
    head = (await client.get("/v2/seo/head/MagIC/", headers=CANONICAL)).text
    data = json.loads(re.search(r'ld\+json">(.*)</script>', head).group(1))
    assert data["@type"] == "DataCatalog"
    assert "1,234 public contributions" in data["description"]
    assert data["potentialAction"]["target"].endswith("/MagIC/search?q={search_term_string}")


async def test_bodies_are_readable_text(client):
    body = (await client.get("/v2/seo/body/MagIC/12345", headers=CANONICAL)).text
    assert body.startswith('<div class="fiesta-prerender"><h1>')
    assert "doi:10.7288/V4/MAGIC/12345" in body
    page = (await client.get("/v2/seo/body/MagIC/about", headers=CANONICAL)).text
    assert "<h1>About</h1>" in page and "<script" not in page


async def test_robots_lists_every_sitemap(client):
    robots = (await client.get("/v2/robots.txt", headers=CANONICAL)).text
    assert "Sitemap: https://earthref.org/MagIC/sitemap.xml" in robots
    assert "Disallow: /MagIC/private" in robots


async def test_sitemap_lists_public_contributions(client):
    response = await client.get("/v2/magic/sitemap.xml")
    assert response.headers["content-type"].startswith("application/xml")
    xml = response.text
    assert "<loc>https://earthref.org/MagIC/7</loc><lastmod>2026-01-02</lastmod>" in xml
    assert "<loc>https://earthref.org/MagIC/9</loc></url>" in xml
    assert "<loc>https://earthref.org/MagIC/about</loc>" in xml
    assert "jupyter-notebooks" not in xml  # a hidden page


async def test_llms_txt(client):
    index = (await client.get("/v2/llms.txt")).text
    assert index.startswith("# EarthRef.org\n")
    assert "(https://earthref.org/MagIC/llms.txt)" in index
    node = (await client.get("/v2/magic/llms.txt", headers=CANONICAL)).text
    assert node.startswith("# Magnetics Information Consortium (MagIC)\n")
    assert "1,234 public contributions" in node
    assert "https://earthref.org/MagIC/v2/magic/contributions/<id>/jsonld" in node
