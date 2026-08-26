"""Shared FastAPI dependencies."""

from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials, OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from fiesta.db.models import User
from fiesta.db.session import get_session
from fiesta.nodeconfig import NodeConfig, get_node
from fiesta.security import decode_access_token, verify_password

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)
basic_scheme = HTTPBasic(auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]
NodeDep = Annotated[NodeConfig, Depends(get_node)]


async def get_current_user(
    session: SessionDep, token: Annotated[str | None, Depends(oauth2_scheme)]
) -> User:
    user_id = decode_access_token(token) if token else None
    user = await session.get(User, user_id) if user_id is not None else None
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_basic_user(
    session: SessionDep,
    credentials: Annotated[HTTPBasicCredentials | None, Depends(basic_scheme)],
) -> User:
    """Legacy-compatible HTTP Basic auth (public API): EarthRef email or
    handle + password."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Basic"},
        )
    result = await session.execute(
        select(User).where(
            (User.email == credentials.username) | (User.handle == credentials.username)
        )
    )
    user = result.scalar_one_or_none()
    if user is None or not verify_password(credentials.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Basic"},
        )
    return user


BasicUser = Annotated[User, Depends(get_basic_user)]
