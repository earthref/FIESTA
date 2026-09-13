"""Shared FastAPI dependencies."""

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials, OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from fiesta.db.models import User
from fiesta.db.session import get_session
from fiesta.nodeconfig import NodeConfig, get_deployment
from fiesta.security import decode_access_token, verify_password

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/v2/auth/login", auto_error=False)
basic_scheme = HTTPBasic(auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]


def request_node(request: Request) -> NodeConfig:
    """The node named by the `{repository}` path segment (key or slug, any
    case). Every node-scoped route is mounted under /v2/{repository}."""
    repository = request.path_params.get("repository")
    if not repository:
        raise RuntimeError("NodeDep used on a route without a {repository} path segment")
    try:
        return get_deployment().node_for(repository)
    except KeyError:
        raise HTTPException(404, f"unknown repository {repository!r}") from None


NodeDep = Annotated[NodeConfig, Depends(request_node)]


async def get_current_user(
    session: SessionDep,
    token: Annotated[str | None, Depends(oauth2_scheme)],
    credentials: Annotated[HTTPBasicCredentials | None, Depends(basic_scheme)],
) -> User:
    if not token and credentials:
        return await get_basic_user(session, credentials)
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
