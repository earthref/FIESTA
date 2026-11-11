from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select

from fiesta.apps.deps import CurrentUser, SessionDep
from fiesta.apps.routers.admin import ensure_unique_user_fields
from fiesta.apps.schemas import AccountPatchIn, PasswordIn, RegisterIn, TokenOut, UserOut
from fiesta.db.models import User
from fiesta.nodeconfig import get_deployment
from fiesta.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=201)
async def register(payload: RegisterIn, session: SessionDep) -> UserOut:
    email = payload.email.strip().lower()
    existing = (
        await session.execute(select(User).where(func.lower(User.email) == email))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "an account with this email already exists")
    if len(payload.password) < 8:
        raise HTTPException(422, "password must be at least 8 characters")
    user = User(email=email, name=payload.name, password_hash=hash_password(payload.password))
    session.add(user)
    await session.commit()
    return UserOut.from_db(user)


@router.post("/login", response_model=TokenOut)
async def login(
    form: Annotated[OAuth2PasswordRequestForm, Depends()], session: SessionDep
) -> TokenOut:
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
async def me(user: CurrentUser) -> UserOut:
    return UserOut.from_db(user)


@router.patch("/me", response_model=UserOut)
async def update_me(payload: AccountPatchIn, user: CurrentUser, session: SessionDep) -> UserOut:
    """Edit the signed-in user's own name, email, handle and ORCID."""
    fields = payload.model_dump(exclude_unset=True)
    email = (fields.get("email") or "").strip().lower() or None
    if email == user.email:
        email = None
    if email:
        # A legacy sync finds owners by email and creates a missing one, so a
        # changed address would split the account while any node still syncs.
        syncing = [
            n.node.key for n in get_deployment().node_list if n.contributions_mode == "source"
        ]
        if syncing:
            raise HTTPException(
                409,
                f"email changes are unavailable while {', '.join(syncing)} sync from the "
                "legacy site; contact webmaster@earthref.org",
            )
    await ensure_unique_user_fields(
        session, email, fields.get("handle"), fields.get("orcid"), exclude=user.id
    )
    if email:
        user.email = email
    if name := (fields.get("name") or "").strip():
        user.name = name
    for field in ("handle", "orcid"):
        if field in fields:
            setattr(user, field, fields[field] or None)
    await session.commit()
    return UserOut.from_db(user)


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
