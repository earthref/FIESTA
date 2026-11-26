"""Passwordless sign-in (fiesta.services.sign_in, /v2/auth): what each provider
is trusted for, the redirect checks, and (FIESTA_INTEGRATION=1, against
Postgres) the emailed-link and OAuth flows end to end."""

import os
import re
import uuid

import httpx
import jwt
import pytest
from fastapi import HTTPException

from fiesta.services import sign_in

CLIENT = "client-123"


@pytest.fixture
def configured(monkeypatch):
    """Every provider configured, as a deployment with all four apps would be."""
    from fiesta.settings import get_settings

    settings = get_settings()
    for provider in ("google", "microsoft", "github", "orcid"):
        monkeypatch.setattr(settings, f"{provider}_client_id", CLIENT)
        monkeypatch.setattr(settings, f"{provider}_client_secret", "secret")
    return settings


def _id_token(**claims) -> str:
    return jwt.encode({"aud": CLIENT, **claims}, "provider-key", algorithm="HS256")


def _transport(routes: dict[str, dict | list]) -> httpx.MockTransport:
    """Answer each URL (without query) with its JSON; record nothing else."""

    def handle(request: httpx.Request) -> httpx.Response:
        url = str(request.url).split("?")[0]
        if url not in routes:
            return httpx.Response(404, json={})
        return httpx.Response(200, json=routes[url])

    return httpx.MockTransport(handle)


async def _profile(provider_id: str, routes: dict) -> sign_in.Profile:
    provider = sign_in.get_provider(provider_id)
    async with httpx.AsyncClient(transport=_transport(routes)) as client:
        return await sign_in.fetch_profile(provider, "code", "https://x/callback", client)


def test_only_configured_providers_are_offered(monkeypatch, configured):
    monkeypatch.setattr(configured, "github_client_secret", "")
    assert [p.id for p in sign_in.enabled_providers()] == ["google", "microsoft", "orcid"]
    with pytest.raises(sign_in.SignInError):
        sign_in.get_provider("github")


@pytest.mark.asyncio
async def test_google_vouches_for_its_verified_email(configured):
    token = _id_token(
        iss="https://accounts.google.com",
        sub="g-1",
        email="Ada@Example.org",
        email_verified=True,
        given_name="Ada",
        family_name="Lovelace",
    )
    profile = await _profile("google", {"https://oauth2.googleapis.com/token": {"id_token": token}})
    assert (profile.subject, profile.email, profile.email_verified) == (
        "g-1",
        "Ada@Example.org",
        True,
    )
    assert (profile.first_name, profile.last_name) == ("Ada", "Lovelace")


@pytest.mark.asyncio
async def test_an_id_token_for_another_app_is_refused(configured):
    token = jwt.encode(
        {"aud": "someone-else", "iss": "https://accounts.google.com", "sub": "g-1"}, "k"
    )
    with pytest.raises(sign_in.SignInError):
        await _profile("google", {"https://oauth2.googleapis.com/token": {"id_token": token}})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tenant", "extra", "verified"),
    [
        (sign_in.MICROSOFT_CONSUMERS, {}, True),  # a personal account's sign-in address
        ("tenant-a", {}, False),  # a work account's email may be anybody's
        ("tenant-a", {"xms_edov": True}, True),  # ... unless the tenant owns the domain
    ],
)
async def test_microsoft_vouches_only_for_owned_addresses(configured, tenant, extra, verified):
    token = _id_token(
        iss=f"https://login.microsoftonline.com/{tenant}/v2.0",
        tid=tenant,
        oid="o-1",
        sub="s-1",
        email="ada@example.org",
        name="Ada King Lovelace",
        **extra,
    )
    url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    profile = await _profile("microsoft", {url: {"id_token": token}})
    assert profile.subject == f"{tenant}:o-1"
    assert profile.email_verified is verified
    assert (profile.first_name, profile.last_name) == ("Ada King", "Lovelace")


@pytest.mark.asyncio
async def test_microsoft_issuer_must_match_the_tenant(configured):
    token = _id_token(iss="https://evil.example/v2.0", tid="t", oid="o", sub="s")
    url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    with pytest.raises(sign_in.SignInError):
        await _profile("microsoft", {url: {"id_token": token}})


@pytest.mark.asyncio
async def test_github_uses_the_primary_verified_email(configured):
    profile = await _profile(
        "github",
        {
            "https://github.com/login/oauth/access_token": {"access_token": "gh"},
            "https://api.github.com/user": {"id": 42, "name": "Ada Lovelace"},
            "https://api.github.com/user/emails": [
                {"email": "old@example.org", "verified": False, "primary": True},
                {"email": "ada@example.org", "verified": True, "primary": False},
            ],
        },
    )
    assert (profile.subject, profile.email, profile.email_verified) == (
        "42",
        "ada@example.org",
        True,
    )


@pytest.mark.asyncio
async def test_orcid_reads_the_records_public_email(configured):
    token = _id_token(iss="https://orcid.org", sub="0000-0002-1825-0097", given_name="Ada")
    profile = await _profile(
        "orcid",
        {
            "https://orcid.org/oauth/token": {"id_token": token, "orcid": "0000-0002-1825-0097"},
            "https://pub.orcid.org/v3.0/0000-0002-1825-0097/email": {
                "email": [{"email": "ada@example.org", "verified": True, "primary": True}]
            },
        },
    )
    assert profile.subject == "0000-0002-1825-0097"
    assert (profile.email, profile.email_verified, profile.first_name) == (
        "ada@example.org",
        True,
        "Ada",
    )


@pytest.mark.asyncio
async def test_a_failed_token_exchange_is_a_sign_in_error(configured):
    with pytest.raises(sign_in.SignInError):
        await _profile("google", {})


def test_state_is_signed_and_expires():
    page = "https://earthref.org/MagIC/"
    state = sign_in.encode_state("google", page, "n" * 16, "cb", None)
    claims = sign_in.decode_state(state)
    assert (claims["p"], claims["r"], claims["l"]) == ("google", page, None)
    assert sign_in.decode_state(state[:-2] + "xx") is None
    assert sign_in.decode_state(jwt.encode({"p": "google"}, "other-key")) is None


@pytest.mark.parametrize(
    ("url", "ok"),
    [
        ("https://dev.earthref.org/MagIC/search#x", True),  # FIESTA_SIGN_IN_ORIGINS
        ("https://earthref.org/CDR/", True),  # the canonical site
        ("http://localhost:5173/MagIC/", True),  # a CORS origin
        ("http://dev.earthref.org/MagIC/", False),  # another scheme is another origin
        ("https://evil.example/MagIC/", False),
        ("https://dev.earthref.org.evil.example/", False),
        ("https://earthref.org@evil.example/", False),
        ("javascript:alert(1)", False),
    ],
)
def test_sign_in_returns_only_to_configured_origins(monkeypatch, url, ok):
    # Never to the requester's Host header: a forged one would mail a victim a
    # genuine link that hands its secret to another site.
    from fiesta.apps.routers.auth import checked_return
    from fiesta.settings import get_settings

    monkeypatch.setattr(get_settings(), "cors_origins", ["http://localhost:5173"])
    monkeypatch.setattr(get_settings(), "sign_in_origins", ["https://dev.earthref.org"])
    if ok:
        assert checked_return(url) == url.split("#")[0]
    else:
        with pytest.raises(HTTPException):
            checked_return(url)


@pytest.mark.skipif(
    os.getenv("FIESTA_INTEGRATION") != "1", reason="requires isolated Docker integration stack"
)
@pytest.mark.asyncio
async def test_sign_in_flows_against_postgres(monkeypatch, configured):
    """An emailed link signs up and verifies; Google joins the account by its
    verified email; a Microsoft work account cannot claim an address it does
    not own, but connects once signed in; an email change waits for its link."""
    from fiesta.apps.api import create_app
    from fiesta.apps.routers import auth

    mail: list[tuple[str, str]] = []

    async def deliver(to, subject, body):
        mail.append((to, body))

    def secret() -> str:
        return re.search(r"#fiesta_link=([\w-]+)", mail[-1][1]).group(1)

    microsoft = {}  # the claims the mock Microsoft returns next

    def provider_routes():
        google = _id_token(
            iss="https://accounts.google.com",
            sub=f"g-{email}",
            email=email,
            email_verified=True,
            given_name="Ada",
            family_name="Lovelace",
        )
        return {
            "https://oauth2.googleapis.com/token": {"id_token": google},
            "https://login.microsoftonline.com/common/oauth2/v2.0/token": {
                "id_token": _id_token(**microsoft)
            },
        }

    monkeypatch.setattr(configured, "sign_in_origins", ["http://local"])
    monkeypatch.setattr(sign_in, "deliver", deliver)
    monkeypatch.setattr(
        auth, "http_client", lambda: httpx.AsyncClient(transport=_transport(provider_routes()))
    )
    email = f"ada-{uuid.uuid4().hex[:8]}@example.org"
    page = "http://local/MagIC/private"
    app = create_app()
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local") as c,
    ):

        async def oauth(provider: str, headers=None, link=False) -> httpx.Response:
            start = await c.post(
                f"/v2/auth/oauth/{provider}/start",
                json={"return_to": page, "nonce": "n" * 16, "link": link},
                headers=headers or {},
            )
            assert start.status_code == 200, start.text
            state = re.search(r"state=([^&]+)", start.json()["url"]).group(1)
            return await c.get(f"/v2/auth/oauth/{provider}/callback?code=c&state={state}")

        def fragment(response) -> dict:
            from urllib.parse import parse_qs, urlsplit

            assert response.status_code == 303
            location = response.headers["location"]
            assert location.startswith(page + "#")
            return {k: v[0] for k, v in parse_qs(urlsplit(location).fragment).items()}

        # Sign up by emailed link: the account exists, verified, nothing else yet.
        sent = await c.post("/v2/auth/email-link", json={"email": email, "return_to": page})
        assert sent.status_code == 202 and mail[-1][0] == email
        token = (await c.post("/v2/auth/email-link/verify", json={"token": secret()})).json()
        bearer = {"Authorization": f"Bearer {token['access_token']}"}
        me = (await c.get("/v2/auth/me", headers=bearer)).json()
        assert me["email_verified"] and me["sign_ins"] == []
        assert me["profile_missing"] == ["first_name", "last_name", "affiliation"]
        # A link works once.
        again = await c.post("/v2/auth/email-link/verify", json={"token": secret()})
        assert again.status_code == 400

        async def exchange(back: dict, nonce: str = "n" * 16) -> httpx.Response:
            return await c.post(
                "/v2/auth/exchange", json={"token": back["fiesta_login"], "nonce": nonce}
            )

        # A hand-off redeemed without the starting tab's nonce links nothing, and is spent.
        stray = fragment(await oauth("google"))
        assert (await exchange(stray, nonce="x" * 16)).status_code == 400
        assert (await exchange(stray)).status_code == 400
        me = (await c.get("/v2/auth/me", headers=bearer)).json()
        assert me["sign_ins"] == [] and me["first_name"] is None

        # Google vouches for the same address: same account, names filled in.
        back = fragment(await oauth("google"))
        assert back["nonce"] == "n" * 16
        exchanged = await exchange(back)
        google_bearer = {"Authorization": f"Bearer {exchanged.json()['access_token']}"}
        me = (await c.get("/v2/auth/me", headers=google_bearer)).json()
        assert me["id"] == (await c.get("/v2/auth/me", headers=bearer)).json()["id"]
        assert (me["first_name"], me["last_name"]) == ("Ada", "Lovelace")
        assert me["sign_ins"] == ["google"]
        assert (await exchange(back)).status_code == 400  # single use

        # A Microsoft work account naming this address unverified cannot sign in to it ...
        tenant = "tenant-a"
        microsoft.update(
            iss=f"https://login.microsoftonline.com/{tenant}/v2.0",
            tid=tenant,
            oid=f"o-{email}",
            sub="s",
            email=email,
        )
        refused = await exchange(fragment(await oauth("microsoft")))
        assert refused.status_code == 400 and "emailed link" in refused.json()["detail"]
        # ... but the signed-in owner connects it, and then it signs in.
        assert (await exchange(fragment(await oauth("microsoft", bearer, link=True)))).is_success
        assert (await exchange(fragment(await oauth("microsoft")))).is_success
        me = (await c.get("/v2/auth/me", headers=bearer)).json()
        assert me["sign_ins"] == ["google", "microsoft"]

        # The profile completes; an email change applies only once its link is used.
        patch = await c.patch("/v2/auth/me", json={"affiliation": "Scripps"}, headers=bearer)
        assert patch.json()["profile_missing"] == []
        new = f"new-{email}"
        changed = await c.post(
            "/v2/auth/email-change", json={"email": new, "return_to": page}, headers=bearer
        )
        if changed.status_code == 409:  # a node syncs from its legacy source here
            return
        assert changed.status_code == 202 and mail[-1][0] == new
        assert (await c.get("/v2/auth/me", headers=bearer)).json()["email"] == email
        await c.post("/v2/auth/email-link/verify", json={"token": secret()})
        me = (await c.get("/v2/auth/me", headers=bearer)).json()
        assert (me["email"], me["email_verified"]) == (new, True)
