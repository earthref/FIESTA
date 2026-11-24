"""Sign-in and the signed-in user's own account (node-less: /v2/auth/...).

People sign in passwordlessly (fiesta.services.sign_in): an emailed one-time
link, or Google, Microsoft, GitHub or ORCID. Every route that ends a sign-in
answers with a bearer token. POST /login (a password) stays for scripts and
service accounts; the web app never offers it.
"""

import logging
import secrets
from dataclasses import asdict
from typing import Annotated
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select

from fiesta.apps.deps import CurrentUser, OptionalUser, SessionDep
from fiesta.apps.public_urls import api_base, site_url
from fiesta.apps.routers.admin import ensure_unique_user_fields
from fiesta.apps.schemas import (
    AccountPatchIn,
    EmailChangeIn,
    EmailLinkIn,
    ExchangeIn,
    OAuthStartIn,
    PasswordIn,
    ProvidersOut,
    SecretIn,
    TokenOut,
    UserOut,
)
from fiesta.db.models import User, UserIdentity
from fiesta.nodeconfig import get_deployment
from fiesta.security import create_access_token, hash_password, verify_password
from fiesta.services import sign_in
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


def http_client() -> httpx.AsyncClient:
    """The client provider calls go through (tests substitute a mock transport)."""
    return httpx.AsyncClient(timeout=20)


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def checked_return(return_to: str) -> str:
    """RETURN_TO, a page of this web app: its origin is api.site_url's, a CORS
    origin or a FIESTA_SIGN_IN_ORIGINS one. Anything else would make sign-in an
    open redirect that hands out secrets: an emailed link pointing at another
    site, or a provider's hand-off code delivered there. Configuration only,
    never the request's Host header, which the requester controls."""
    parts = urlsplit(return_to)
    settings = get_settings()
    allowed = {
        _origin(site_url()),
        *map(_origin, settings.cors_origins),
        *map(_origin, settings.sign_in_origins),
    }
    if parts.scheme not in ("http", "https") or _origin(return_to) not in allowed:
        raise HTTPException(422, "return_to must be a page of this site")
    return return_to.split("#")[0]


async def me_out(session, user: User) -> UserOut:
    return UserOut.from_db(user, sign_ins=await sign_in.identities(session, user.id))


@router.get("/providers", response_model=ProvidersOut)
async def providers() -> ProvidersOut:
    """The external sign-ins this deployment offers (an emailed link always works)."""
    return ProvidersOut(
        providers=[{"id": p.id, "name": p.name} for p in sign_in.enabled_providers()]
    )


@router.post("/email-link", status_code=202)
async def email_link(payload: EmailLinkIn, session: SessionDep) -> dict:
    """Email a one-time sign-in link back to RETURN_TO. Signs up an address
    without an account. The answer never says whether an account exists."""
    return_to = checked_return(payload.return_to)
    email = str(payload.email).strip().lower()
    minutes = get_settings().sign_in_link_minutes
    if await sign_in.recent_links(session, email) >= sign_in.LINKS_PER_WINDOW:
        logger.info("sign-in link for %s throttled", email)
        return {"sent": True}
    secret = await sign_in.issue_token(session, "email", minutes, email=email)
    site = sign_in.site_name(return_to)
    await _send(
        email,
        f"Sign in to {site}",
        f"Use this link to sign in to {site}. It works once and expires in {minutes} "
        f"minutes.\n\n{sign_in.link_url(return_to, secret)}\n\n"
        "If you did not ask to sign in, you can ignore this email: nobody can use it "
        "without the link.\n\nOne EarthRef account signs you in to every EarthRef.org "
        "repository.\n",
    )
    await session.commit()
    return {"sent": True}


async def _send(to: str, subject: str, body: str) -> None:
    try:
        await sign_in.deliver(to, subject, body)
    except Exception as error:  # SMTP down: say so rather than pretend it was sent
        logger.exception("sign-in email to %s failed", to)
        raise HTTPException(503, "the email could not be sent; please try again later") from error


@router.post("/email-link/verify", response_model=TokenOut)
async def verify_email_link(payload: SecretIn, session: SessionDep) -> TokenOut:
    """Sign in with an emailed link's secret, creating the account on first use,
    and mark the address verified (an email change takes effect here)."""
    token = await sign_in.consume_token(session, payload.token, ("email", "email_change"))
    if token is None or not token.email:
        raise HTTPException(400, "this sign-in link has expired or was already used")
    holder = await sign_in.user_by_email(session, token.email)
    if token.purpose == "email_change":
        user = await session.get(User, token.user_id)
        if user is None:
            raise HTTPException(400, "this link's account no longer exists")
        if holder is not None and holder.id != user.id:
            raise HTTPException(409, "another account now uses this email address")
        user.email = token.email
        user.email_verified_at = None
    else:
        user = holder
        if user is None:
            user = User(email=token.email, name=token.email)
            session.add(user)
            await session.flush()
    sign_in.mark_verified(user, token.email)
    await session.commit()
    return TokenOut(access_token=create_access_token(user.id))


@router.post("/oauth/{provider_id}/start")
async def oauth_start(
    provider_id: str,
    payload: OAuthStartIn,
    request: Request,
    user: OptionalUser,
) -> dict:
    """The provider URL to send the browser to. With `link`, the signed-in
    user connects this provider to their account instead of signing in."""
    try:
        provider = sign_in.get_provider(provider_id)
    except sign_in.SignInError as error:
        raise HTTPException(404, str(error)) from None
    if payload.link and user is None:
        raise HTTPException(401, "sign in before connecting another sign-in")
    return_to = checked_return(payload.return_to)
    base = get_settings().oauth_redirect_base.rstrip("/") or api_base(request)
    redirect_uri = f"{base}/auth/oauth/{provider.id}/callback"
    state = sign_in.encode_state(
        provider.id, return_to, payload.nonce, redirect_uri, user.id if payload.link else None
    )
    return {"url": sign_in.authorize_url(provider, redirect_uri, state)}


@router.get("/oauth/{provider_id}/callback", include_in_schema=False)
async def oauth_callback(
    provider_id: str,
    session: SessionDep,
    state: str = "",
    code: str = "",
    error: str = "",
):
    """The provider sends the browser here; it goes back to the page it came
    from with a one-time hand-off code (or an error) in the URL fragment.
    Nothing is linked or created yet: POST /exchange does that, for the tab
    holding the flow's nonce only, so a flow started by someone else and
    finished in a victim's browser attaches nothing to anyone."""
    claims = sign_in.decode_state(state)
    if claims is None or claims.get("p") != provider_id:
        return HTMLResponse(
            "<p>This sign-in expired or did not start here. Go back and sign in again.</p>",
            status_code=400,
        )

    def back(**fragment) -> RedirectResponse:
        fragment["nonce"] = claims["n"]
        return RedirectResponse(f"{claims['r']}#{urlencode(fragment)}", status_code=303)

    if error or not code:
        return back(fiesta_login_error="sign-in was cancelled")
    try:
        provider = sign_in.get_provider(provider_id)
        async with http_client() as client:
            profile = await sign_in.fetch_profile(provider, code, claims["u"], client)
        handoff = await sign_in.issue_token(
            session,
            "oauth",
            sign_in.HANDOFF_MINUTES,
            payload={
                "provider": provider.id,
                "profile": asdict(profile),
                "nonce": claims["n"],
                "link": claims.get("l"),
            },
        )
        await session.commit()
    except sign_in.SignInError as failure:
        await session.rollback()
        return back(fiesta_login_error=str(failure))
    except (httpx.HTTPError, KeyError, ValueError, TypeError):
        await session.rollback()
        logger.exception("%s sign-in failed", provider_id)
        return back(fiesta_login_error="sign-in failed; please try again")
    return back(fiesta_login=handoff)


@router.post("/exchange", response_model=TokenOut)
async def exchange(payload: ExchangeIn, session: SessionDep) -> TokenOut:
    """Finish an external sign-in: the callback's hand-off code and the nonce
    the starting tab kept. Links or creates the account (fiesta.services.sign_in
    .resolve_user) and answers a token; 400 with the reason when it cannot."""
    token = await sign_in.consume_token(session, payload.token, ("oauth",))
    data = (token.payload or {}) if token else {}
    if not data or not secrets.compare_digest(str(data.get("nonce")), payload.nonce):
        await session.commit()  # a wrong nonce spends the code: no second guess
        raise HTTPException(400, "this sign-in has expired; please sign in again")
    try:
        provider = sign_in.get_provider(data["provider"])
        link_user = await session.get(User, data["link"]) if data.get("link") else None
        if data.get("link") and link_user is None:
            raise sign_in.SignInError("the account to connect no longer exists")
        user = await sign_in.resolve_user(
            session, provider, sign_in.Profile(**data["profile"]), link_user
        )
    except sign_in.SignInError as failure:
        await session.rollback()
        raise HTTPException(400, str(failure)) from None
    await session.commit()
    return TokenOut(access_token=create_access_token(user.id))


@router.delete("/identities/{provider_id}", status_code=204)
async def disconnect(provider_id: str, user: CurrentUser, session: SessionDep) -> None:
    """Stop signing in with PROVIDER (an emailed link to the account's address
    always remains)."""
    rows = await session.execute(
        select(UserIdentity).where(
            UserIdentity.user_id == user.id, UserIdentity.provider == provider_id
        )
    )
    for identity in rows.scalars():
        await session.delete(identity)
    await session.commit()


@router.post("/login", response_model=TokenOut)
async def login(
    form: Annotated[OAuth2PasswordRequestForm, Depends()], session: SessionDep
) -> TokenOut:
    """A password sign-in for scripts and service accounts (data-source syncs,
    the e2e script); people sign in with an emailed link or a provider."""
    username = form.username.strip().lower()
    result = await session.execute(
        select(User).where(
            (func.lower(User.email) == username) | (func.lower(User.handle) == username)
        )
    )
    user = result.scalar_one_or_none()
    if user is None or not verify_password(form.password, user.password_hash):
        raise HTTPException(401, "incorrect email or password")
    return TokenOut(access_token=create_access_token(user.id))


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser, session: SessionDep) -> UserOut:
    return await me_out(session, user)


@router.patch("/me", response_model=UserOut)
async def update_me(payload: AccountPatchIn, user: CurrentUser, session: SessionDep) -> UserOut:
    """Edit the signed-in user's own name, affiliation and handle. The email
    changes through POST /email-change (verified first); the ORCID iD through
    connecting ORCID (it is never typed in: an ORCID sign-in trusts it)."""
    fields = payload.model_dump(exclude_unset=True)
    await ensure_unique_user_fields(session, None, fields.get("handle"), None, exclude=user.id)
    for field in ("first_name", "last_name", "affiliation"):
        if field in fields:
            setattr(user, field, (fields[field] or "").strip() or None)
    if "handle" in fields:
        user.handle = fields["handle"] or None
    if user.first_name and user.last_name:
        user.name = sign_in.display_name(user)[:255]
    elif name := (fields.get("name") or "").strip():
        user.name = name
    await session.commit()
    return await me_out(session, user)


@router.post("/email-change", status_code=202)
async def email_change(payload: EmailChangeIn, user: CurrentUser, session: SessionDep) -> dict:
    """Email a confirmation link to a new address; the account's email changes
    (verified) when it is used, so nobody can claim an address they do not read."""
    return_to = checked_return(payload.return_to)
    email = str(payload.email).strip().lower()
    if email == user.email.lower():
        raise HTTPException(422, "this is already your email address")
    # A legacy sync finds owners by email and creates a missing one, so a
    # changed address would split the account while any node still syncs.
    syncing = [n.node.key for n in get_deployment().node_list if n.contributions_mode == "source"]
    if syncing:
        raise HTTPException(
            409,
            f"email changes are unavailable while {', '.join(syncing)} sync from the "
            "legacy site; contact webmaster@earthref.org",
        )
    await ensure_unique_user_fields(session, email, None, None, exclude=user.id)
    if await sign_in.recent_links(session, email) >= sign_in.LINKS_PER_WINDOW:
        raise HTTPException(429, "too many links sent to this address; try again later")
    minutes = get_settings().sign_in_link_minutes
    secret = await sign_in.issue_token(
        session, "email_change", minutes, email=email, user_id=user.id
    )
    site = sign_in.site_name(return_to)
    await _send(
        email,
        f"Confirm your new {site} email address",
        f"{user.name} asked to use this address for their EarthRef account. "
        f"Open this link within {minutes} minutes to confirm it:\n\n"
        f"{sign_in.link_url(return_to, secret)}\n\n"
        "If you did not ask for this, ignore this email.\n",
    )
    await session.commit()
    return {"sent": True}


@router.post("/password", status_code=204)
async def change_password(payload: PasswordIn, user: CurrentUser, session: SessionDep) -> None:
    """Set a new password; the current one is required when the account has one."""
    if user.password_hash and not verify_password(
        payload.current_password or "", user.password_hash
    ):
        raise HTTPException(403, "current password is incorrect")
    user.password_hash = hash_password(payload.new_password)
    await session.commit()


@router.post("/local-login", response_model=TokenOut | None)
async def local_login(session: SessionDep) -> TokenOut | None:
    """Sign in Local Developer only against local development infrastructure,
    creating the seed manifest's accounts first on a stack not yet seeded."""
    from fiesta.services.seed import ensure_local_accounts, require_local

    try:
        require_local()
    except ValueError:
        return None
    user = await ensure_local_accounts(session)
    if user is None:
        return None  # No node in this deployment has a seed manifest.
    return TokenOut(access_token=create_access_token(user.id))


@router.get("/settings")
async def settings(user: CurrentUser):
    return user.settings


@router.put("/settings")
async def save_settings(payload: dict, user: CurrentUser, session: SessionDep):
    import json

    if len(json.dumps(payload)) > 16384:
        raise HTTPException(422, "settings exceed 16 KiB")
    user.settings = payload
    await session.commit()
    return user.settings
