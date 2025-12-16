"""
Dependencies for API endpoints.
"""
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import decode_token
from app.db.session import get_db
from app.schemas.token import TokenPayload, UserResponse
from app.services.user import get_user

# OAuth2 scheme for token authentication
oauth2_scheme = OAuth2PasswordBearer(
    tokenUrl=f"{settings.API_V1_STR}/authenticate"
)


async def get_current_user(
    db: AsyncSession = Depends(get_db), token: str = Depends(oauth2_scheme)
) -> UserResponse:
    """
    Get the current authenticated user from the token.
    
    Args:
        db: Database session
        token: JWT token from Authorization header
        
    Returns:
        Authenticated user
        
    Raises:
        HTTPException: If authentication fails
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    try:
        payload = decode_token(token)
        user_id: int = int(payload.sub)
        if user_id is None:
            raise credentials_exception
        token_data = TokenPayload(user_id=user_id)
    except (JWTError, ValueError):
        raise credentials_exception
    
    user = await get_user(db, user_id=token_data.user_id)
    if user is None:
        raise credentials_exception
    
    return UserResponse.from_orm(user)


async def get_current_active_user(
    current_user: UserResponse = Depends(get_current_user),
) -> UserResponse:
    """
    Get the current active user.
    
    Args:
        current_user: Current authenticated user
        
    Returns:
        Active user
        
    Raises:
        HTTPException: If user is inactive
    """
    if not current_user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return current_user


async def get_current_active_superuser(
    current_user: UserResponse = Depends(get_current_user),
) -> UserResponse:
    """
    Get the current active superuser.
    
    Args:
        current_user: Current authenticated user
        
    Returns:
        Active superuser
        
    Raises:
        HTTPException: If user is not a superuser
    """
    if not current_user.is_superuser:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The user doesn't have enough privileges",
        )
    return current_user
