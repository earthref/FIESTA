"""
User service for database operations.
"""
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.user import User
from app.schemas.token import UserCreate, UserResponse
from app.core.security import get_password_hash


async def get_user(db: AsyncSession, user_id: int) -> Optional[User]:
    """
    Get a user by ID.
    
    Args:
        db: Database session
        user_id: User ID
        
    Returns:
        User if found, None otherwise
    """
    result = await db.execute(select(User).filter(User.id == user_id))
    return result.scalars().first()


async def get_user_by_email(db: AsyncSession, email: str) -> Optional[User]:
    """
    Get a user by email.
    
    Args:
        db: Database session
        email: User email
        
    Returns:
        User if found, None otherwise
    """
    result = await db.execute(select(User).filter(User.email == email))
    return result.scalars().first()


async def create_user(db: AsyncSession, user_in: UserCreate) -> User:
    """
    Create a new user.
    
    Args:
        db: Database session
        user_in: User data
        
    Returns:
        Created user
    """
    hashed_password = get_password_hash(user_in.password)
    db_user = User(
        email=user_in.email,
        hashed_password=hashed_password,
        full_name=user_in.full_name,
        is_active=True,
    )
    db.add(db_user)
    await db.commit()
    await db.refresh(db_user)
    return db_user


async def update_user_last_login(db: AsyncSession, user: User) -> None:
    """
    Update the user's last login timestamp.
    
    Args:
        db: Database session
        user: User to update
    """
    from sqlalchemy import update
    from sqlalchemy.sql import func
    
    stmt = (
        update(User)
        .where(User.id == user.id)
        .values(last_login=func.now())
    )
    await db.execute(stmt)
    await db.commit()


async def authenticate(
    db: AsyncSession, email: str, password: str
) -> Optional[UserResponse]:
    """
    Authenticate a user.
    
    Args:
        db: Database session
        email: User email
        password: User password
        
    Returns:
        User if authentication is successful, None otherwise
    """
    from app.core.security import verify_password
    
    user = await get_user_by_email(db, email=email)
    if not user:
        return None
    if not verify_password(password, user.hashed_password):
        return None
    
    # Update last login time
    await update_user_last_login(db, user)
    
    return UserResponse.from_orm(user)
