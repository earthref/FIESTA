"""
Pydantic schemas for authentication and tokens.
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, EmailStr


class Token(BaseModel):
    """Base token schema."""
    access_token: str
    token_type: str = "bearer"


class TokenPayload(BaseModel):
    """JWT token payload."""
    sub: Optional[int] = None
    exp: Optional[datetime] = None


class UserLogin(BaseModel):
    """User login schema."""
    email: EmailStr
    password: str


class UserInDB(BaseModel):
    """User in database schema."""
    id: int
    email: EmailStr
    is_active: bool = True
    is_superuser: bool = False

    class Config:
        orm_mode = True


class UserCreate(BaseModel):
    """User creation schema."""
    email: EmailStr
    password: str
    full_name: Optional[str] = None


class UserResponse(BaseModel):
    """User response schema."""
    id: int
    email: EmailStr
    full_name: Optional[str] = None
    is_active: bool = True
    is_superuser: bool = False

    class Config:
        orm_mode = True
