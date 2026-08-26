from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select

from fiesta.apps.deps import CurrentUser, SessionDep
from fiesta.apps.schemas import RegisterIn, TokenOut, UserOut
from fiesta.db.models import User
from fiesta.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=201)
async def register(payload: RegisterIn, session: SessionDep) -> UserOut:
    existing = (
        await session.execute(select(User).where(User.email == payload.email))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "an account with this email already exists")
    if len(payload.password) < 8:
        raise HTTPException(422, "password must be at least 8 characters")
    user = User(
        email=payload.email, name=payload.name, password_hash=hash_password(payload.password)
    )
    session.add(user)
    await session.commit()
    return UserOut.from_db(user)


@router.post("/login", response_model=TokenOut)
async def login(
    form: Annotated[OAuth2PasswordRequestForm, Depends()], session: SessionDep
) -> TokenOut:
    result = await session.execute(
        select(User).where((User.email == form.username) | (User.handle == form.username))
    )
    user = result.scalar_one_or_none()
    if user is None or not verify_password(form.password, user.password_hash):
        raise HTTPException(401, "incorrect email or password")
    return TokenOut(access_token=create_access_token(user.id))


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> UserOut:
    return UserOut.from_db(user)
