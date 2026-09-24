from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select

from fiesta.apps.deps import CurrentUser, SessionDep
from fiesta.apps.schemas import RegisterIn, TokenOut, UserOut
from fiesta.db.models import User
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


@router.post("/local-login", response_model=TokenOut | None)
async def local_login(session: SessionDep) -> TokenOut | None:
    """Sign in the seeded developer only against local development infrastructure."""
    from fiesta.services.seed import require_local

    try:
        require_local()
    except ValueError:
        return None
    user = (
        await session.execute(select(User).where(User.email == "developer@example.test"))
    ).scalar_one_or_none()
    if user is None:
        return None  # `make seed` has not been run yet.
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
