"""The "Having trouble? Email Us" form (POST /v2/contact): what reaches the
webmaster, the screenshot attachment, and the honeypot and throttle."""

import base64

import httpx
import pytest
from _paths import CONFIG_DIR

from fiesta.db.session import get_session
from fiesta.nodeconfig import get_deployment
from fiesta.settings import get_settings

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


@pytest.fixture
async def sent(monkeypatch):
    monkeypatch.setenv("FIESTA_CONFIG_FILE", str(CONFIG_DIR / "fiesta.yaml"))
    monkeypatch.delenv("FIESTA_NODE", raising=False)
    get_settings.cache_clear()
    get_deployment.cache_clear()
    from fiesta.apps.api import create_app
    from fiesta.apps.routers import contact

    outbox = []

    async def deliver(message):
        outbox.append(message)

    monkeypatch.setattr(contact, "deliver", deliver)
    monkeypatch.setattr(contact, "_sent", type(contact._sent)())
    app = create_app()
    app.dependency_overrides[get_session] = lambda: None
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://a") as c:
        yield c, outbox
    get_settings.cache_clear()
    get_deployment.cache_clear()


def _form(**extra) -> dict:
    return {
        "name": "Ada Lovelace",
        "email": "Ada@Example.org",
        "subject": "Upload fails",
        "message": "The validator hangs.",
        "page": "https://earthref.org/MagIC/upload",
        "repository": "MagIC",
        **extra,
    }


async def test_message_with_screenshot_reaches_the_webmaster(sent):
    client, outbox = sent
    shot = "data:image/png;base64," + base64.b64encode(PNG).decode()
    response = await client.post(
        "/v2/contact", json=_form(screenshot=shot), headers={"User-Agent": "Test/1"}
    )
    assert response.status_code == 202, response.text
    [message] = outbox
    assert message["To"] == "webmaster@earthref.org"
    assert message["Reply-To"] == "Ada Lovelace <ada@example.org>"
    assert message["Subject"] == "[MagIC Help] Upload fails"
    body = message.get_body(("plain",)).get_content()
    assert "The validator hangs." in body
    assert "https://earthref.org/MagIC/upload" in body
    assert "not signed in" in body and "Test/1" in body
    [attachment] = list(message.iter_attachments())
    assert attachment.get_filename() == "screenshot.png"
    assert attachment.get_content() == PNG


async def test_bad_screenshot_honeypot_and_throttle(sent):
    client, outbox = sent
    bad = await client.post("/v2/contact", json=_form(screenshot="data:text/html;base64,PGI+"))
    assert bad.status_code == 422
    bot = await client.post("/v2/contact", json=_form(website="http://spam.example"))
    assert bot.status_code == 202 and outbox == []
    codes = [(await client.post("/v2/contact", json=_form())).status_code for _ in range(6)]
    assert codes == [202] * 5 + [429]
    assert len(outbox) == 5
