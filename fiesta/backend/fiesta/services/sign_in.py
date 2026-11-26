"""Passwordless sign-in: emailed one-time links and external accounts (Google,
Microsoft, GitHub, ORCID over OAuth 2 / OpenID Connect).

Accounts are matched by (provider, subject) once linked. A first sign-in with a
provider joins the account holding the same email only when the provider vouches
for the address (Google `email_verified`, a Microsoft personal account or a
verified-domain claim, a GitHub verified email, an ORCID public verified email),
and only creates an account from such an address: an unverified one could be
anybody's. ORCID also matches the `users.orcid` column, which only legacy
imports, admins and ORCID sign-ins write. Anything else signs in with an emailed
link first and connects the provider from the account page.

One-time secrets (`LoginToken`) are stored as sha256 digests and consumed with a
single conditional UPDATE, so a link works once even under concurrent clicks.
"""

import hashlib
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from urllib.parse import urlencode, urlsplit

import aiosmtplib
import httpx
import jwt
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from fiesta.db.models import LoginToken, User, UserIdentity
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)

# Microsoft's tenant for personal accounts (outlook.com, live.com): the address is
# the account's verified sign-in name.
MICROSOFT_CONSUMERS = "9188040d-6c67-4c5b-b112-36a304b66dad"
STATE_AUDIENCE = "fiesta-oauth"
STATE_MINUTES = 10
HANDOFF_MINUTES = 2
LINKS_PER_WINDOW = 5  # emailed links per address per sign_in_link_minutes


class SignInError(Exception):
    """A sign-in that cannot complete, with a message for the person."""


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    authorize_url: str
    token_url: str
    scope: str

    def credentials(self) -> tuple[str, str]:
        settings = get_settings()
        return (
            getattr(settings, f"{self.id}_client_id"),
            getattr(settings, f"{self.id}_client_secret"),
        )

    @property
    def enabled(self) -> bool:
        return all(self.credentials())


@dataclass
class Profile:
    """What a provider says about the person signing in."""

    subject: str
    email: str | None = None
    email_verified: bool = False
    first_name: str | None = None
    last_name: str | None = None


def providers() -> dict[str, Provider]:
    orcid = get_settings().orcid_url.rstrip("/")
    microsoft = "https://login.microsoftonline.com/common/oauth2/v2.0"
    return {
        p.id: p
        for p in (
            Provider(
                "google",
                "Google",
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://oauth2.googleapis.com/token",
                "openid email profile",
            ),
            Provider(
                "microsoft",
                "Microsoft",
                f"{microsoft}/authorize",
                f"{microsoft}/token",
                "openid email profile",
            ),
            Provider(
                "github",
                "GitHub",
                "https://github.com/login/oauth/authorize",
                "https://github.com/login/oauth/access_token",
                "read:user user:email",
            ),
            Provider(
                "orcid", "ORCID", f"{orcid}/oauth/authorize", f"{orcid}/oauth/token", "openid"
            ),
        )
    }


def enabled_providers() -> list[Provider]:
    return [p for p in providers().values() if p.enabled]


def get_provider(provider_id: str) -> Provider:
    provider = providers().get(provider_id)
    if provider is None or not provider.enabled:
        raise SignInError(f"sign-in with {provider_id!r} is not available")
    return provider


# --- OAuth state -------------------------------------------------------------


def encode_state(
    provider: str, return_to: str, nonce: str, redirect_uri: str, link_user: int | None
) -> str:
    """Signed, short-lived: the callback trusts only what it carries. The SPA
    keeps the nonce and accepts the result only when the fragment echoes it."""
    payload = {
        "aud": STATE_AUDIENCE,
        "exp": datetime.now(UTC) + timedelta(minutes=STATE_MINUTES),
        "p": provider,
        "r": return_to,
        "n": nonce,
        "u": redirect_uri,
        "l": link_user,
    }
    return jwt.encode(payload, get_settings().secret_key, algorithm="HS256")


def decode_state(state: str) -> dict | None:
    try:
        return jwt.decode(
            state, get_settings().secret_key, algorithms=["HS256"], audience=STATE_AUDIENCE
        )
    except jwt.PyJWTError:
        return None


def authorize_url(provider: Provider, redirect_uri: str, state: str) -> str:
    client_id, _ = provider.credentials()
    query = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": provider.scope,
        "state": state,
    }
    if provider.id in ("google", "microsoft"):
        query["prompt"] = "select_account"
    return f"{provider.authorize_url}?{urlencode(query)}"


# --- Provider profiles -----------------------------------------------------------


def _split_name(full: str | None) -> tuple[str | None, str | None]:
    """A best guess for a provider that gives one name field; the person
    confirms it on the account page before publishing."""
    parts = (full or "").split()
    if len(parts) < 2:
        return None, None
    return " ".join(parts[:-1]), parts[-1]


def _id_token_claims(token: dict, client_id: str, issuers: tuple[str, ...] | None) -> dict:
    """Claims of an ID token received directly from the token endpoint over TLS,
    which authenticates the issuer (OpenID Connect Core 3.1.3.7); the audience
    and issuer are still checked."""
    raw = token.get("id_token")
    if not raw:
        raise SignInError("the provider returned no identity")
    claims = jwt.decode(raw, options={"verify_signature": False})
    audience = claims.get("aud")
    if client_id not in (audience if isinstance(audience, list) else [audience]):
        raise SignInError("the provider's identity was issued for another application")
    if issuers is not None and claims.get("iss") not in issuers:
        raise SignInError("the identity came from an unexpected issuer")
    return claims


async def fetch_profile(
    provider: Provider, code: str, redirect_uri: str, client: httpx.AsyncClient
) -> Profile:
    client_id, client_secret = provider.credentials()
    response = await client.post(
        provider.token_url,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "client_secret": client_secret,
        },
        headers={"Accept": "application/json"},
    )
    token = response.json() if response.content else {}
    if response.status_code != 200 or "error" in token:
        logger.warning("%s token exchange failed: %s", provider.id, response.text[:300])
        raise SignInError(f"{provider.name} sign-in failed; please try again")

    if provider.id == "google":
        claims = _id_token_claims(
            token, client_id, ("accounts.google.com", "https://accounts.google.com")
        )
        return Profile(
            subject=str(claims["sub"]),
            email=claims.get("email"),
            email_verified=claims.get("email_verified") is True,
            first_name=claims.get("given_name"),
            last_name=claims.get("family_name"),
        )

    if provider.id == "microsoft":
        claims = _id_token_claims(token, client_id, None)
        tenant = claims.get("tid", "")
        if claims.get("iss") != f"https://login.microsoftonline.com/{tenant}/v2.0":
            raise SignInError("the identity came from an unexpected issuer")
        # Work and school accounts may carry an email nobody verified (unless
        # the tenant owns its domain: the optional xms_edov claim).
        verified = tenant == MICROSOFT_CONSUMERS or claims.get("xms_edov") in (True, "true", "1")
        first, last = claims.get("given_name"), claims.get("family_name")
        if not (first and last):
            first, last = _split_name(claims.get("name"))
        return Profile(
            subject=f"{tenant}:{claims['oid']}" if claims.get("oid") else str(claims["sub"]),
            email=claims.get("email"),
            email_verified=verified and bool(claims.get("email")),
            first_name=first,
            last_name=last,
        )

    if provider.id == "github":
        headers = {
            "Authorization": f"Bearer {token['access_token']}",
            "Accept": "application/vnd.github+json",
        }
        user = (await client.get("https://api.github.com/user", headers=headers)).json()
        emails = (await client.get("https://api.github.com/user/emails", headers=headers)).json()
        verified = [e for e in emails if isinstance(e, dict) and e.get("verified")]
        primary = next((e for e in verified if e.get("primary")), verified[0] if verified else None)
        first, last = _split_name(user.get("name"))
        return Profile(
            subject=str(user["id"]),
            email=primary["email"] if primary else None,
            email_verified=primary is not None,
            first_name=first,
            last_name=last,
        )

    # ORCID: the iD is the subject; an email only if the record makes one public.
    orcid_url = get_settings().orcid_url.rstrip("/")
    claims = _id_token_claims(token, client_id, (orcid_url,))
    orcid = str(token.get("orcid") or claims["sub"])
    email, verified = None, False
    public = orcid_url.replace("://", "://pub.", 1)
    try:
        record = await client.get(
            f"{public}/v3.0/{orcid}/email", headers={"Accept": "application/json"}
        )
        listed = (record.json().get("email") or []) if record.status_code == 200 else []
        best = sorted(listed, key=lambda e: (not e.get("primary"), not e.get("verified")))
        if best:
            email, verified = best[0].get("email"), best[0].get("verified") is True
    except (httpx.HTTPError, ValueError):
        pass  # No public email: the account must already exist or be linked.
    return Profile(
        subject=orcid,
        email=email,
        email_verified=verified,
        first_name=claims.get("given_name"),
        last_name=claims.get("family_name"),
    )


# --- Accounts ----------------------------------------------------------------------


async def user_by_email(session: AsyncSession, email: str) -> User | None:
    return (
        await session.execute(select(User).where(func.lower(User.email) == email.strip().lower()))
    ).scalar_one_or_none()


def display_name(user: User) -> str:
    return " ".join(p for p in (user.first_name, user.last_name) if p) or user.name


def fill_profile(user: User, first: str | None, last: str | None) -> None:
    """Names from a provider fill blanks only; the person's own edits win."""
    if not user.first_name and first:
        user.first_name = first.strip()[:255]
    if not user.last_name and last:
        user.last_name = last.strip()[:255]
    if user.first_name and user.last_name:
        user.name = display_name(user)[:255]


def mark_verified(user: User, email: str | None) -> None:
    if email and email.strip().lower() == user.email.lower() and not user.email_verified_at:
        user.email_verified_at = datetime.now(UTC)


async def resolve_user(
    session: AsyncSession, provider: Provider, profile: Profile, link_user: User | None = None
) -> User:
    """The account this external sign-in belongs to, linking or creating it.
    LINK_USER (a signed-in person connecting the provider) is the only way to
    attach a sign-in whose email the provider does not vouch for."""
    identity = (
        await session.execute(
            select(UserIdentity).where(
                UserIdentity.provider == provider.id, UserIdentity.subject == profile.subject
            )
        )
    ).scalar_one_or_none()
    email = (profile.email or "").strip().lower() or None
    if link_user is not None:
        if identity is not None and identity.user_id != link_user.id:
            raise SignInError(
                f"this {provider.name} account is already connected to another EarthRef account"
            )
        user = link_user
    elif identity is not None:
        user = await session.get(User, identity.user_id)
    else:
        user = None
        if provider.id == "orcid":
            user = (
                await session.execute(select(User).where(User.orcid == profile.subject))
            ).scalar_one_or_none()
        if user is None and email and profile.email_verified:
            user = await user_by_email(session, email)
        if user is None:
            if not email or not profile.email_verified:
                raise SignInError(
                    f"{provider.name} did not confirm an email address for you. Sign in with "
                    f"an emailed link first, then connect {provider.name} on your Account page."
                )
            user = User(email=email, name=email)
            session.add(user)
            await session.flush()
    if user is None:  # the identity's account was deleted under it
        raise SignInError("this sign-in's account no longer exists")

    if provider.id == "orcid" and user.orcid != profile.subject:
        holder = (
            await session.execute(select(User).where(User.orcid == profile.subject))
        ).scalar_one_or_none()
        if holder is not None and holder.id != user.id:
            raise SignInError(
                "this ORCID iD is recorded on another EarthRef account; "
                "contact webmaster@earthref.org to merge them"
            )
        if user.orcid is None or link_user is not None:
            user.orcid = profile.subject

    now = datetime.now(UTC)
    if identity is None:
        identity = UserIdentity(user_id=user.id, provider=provider.id, subject=profile.subject)
        session.add(identity)
    identity.email = email
    identity.last_login_at = now
    fill_profile(user, profile.first_name, profile.last_name)
    if profile.email_verified:
        mark_verified(user, email)
    return user


async def identities(session: AsyncSession, user_id: int) -> list[str]:
    rows = await session.execute(
        select(UserIdentity.provider).where(UserIdentity.user_id == user_id)
    )
    return sorted(set(rows.scalars()))


# --- One-time tokens ----------------------------------------------------------------


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


async def issue_token(
    session: AsyncSession,
    purpose: str,
    minutes: int,
    *,
    email: str | None = None,
    user_id: int | None = None,
    payload: dict | None = None,
) -> str:
    now = datetime.now(UTC)
    await session.execute(delete(LoginToken).where(LoginToken.expires_at < now - timedelta(days=1)))
    secret = secrets.token_urlsafe(32)
    session.add(
        LoginToken(
            token_hash=_digest(secret),
            purpose=purpose,
            email=email,
            user_id=user_id,
            created_at=now,
            expires_at=now + timedelta(minutes=minutes),
            payload=payload,
        )
    )
    return secret


async def consume_token(
    session: AsyncSession, secret: str, purposes: tuple[str, ...]
) -> LoginToken | None:
    now = datetime.now(UTC)
    result = await session.execute(
        update(LoginToken)
        .where(
            LoginToken.token_hash == _digest(secret),
            LoginToken.purpose.in_(purposes),
            LoginToken.used_at.is_(None),
            LoginToken.expires_at > now,
        )
        .values(used_at=now)
        .returning(LoginToken)
    )
    return result.scalar_one_or_none()


async def recent_links(session: AsyncSession, email: str) -> int:
    since = datetime.now(UTC) - timedelta(minutes=get_settings().sign_in_link_minutes)
    return (
        await session.execute(
            select(func.count())
            .select_from(LoginToken)
            .where(
                LoginToken.email == email,
                LoginToken.purpose.in_(("email", "email_change")),
                LoginToken.created_at > since,
            )
        )
    ).scalar_one()


def link_url(return_to: str, secret: str) -> str:
    """The SPA page the person asked from, carrying the secret in the fragment
    (never sent to a server, so never in an access log)."""
    return f"{return_to.split('#')[0]}#fiesta_link={secret}"


async def deliver(to: str, subject: str, body: str) -> None:
    """Send one email now (sign-in links cannot wait for a worker)."""
    settings = get_settings()
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    await aiosmtplib.send(message, hostname=settings.smtp_host, port=settings.smtp_port, timeout=20)


def site_name(return_to: str) -> str:
    """The repository the person is signing in to, from its SPA path (/MagIC/…)."""
    first = urlsplit(return_to).path.strip("/").split("/")[0]
    return f"EarthRef {first}" if first else "EarthRef"
