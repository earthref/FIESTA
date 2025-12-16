"""
Health check endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from app.db.session import get_db
from app.schemas.health_check import HealthCheckResponse

router = APIRouter()


@router.get("/health-check", response_model=HealthCheckResponse)
async def health_check():
    """
    Health check endpoint.
    
    Returns:
        Health status of the API.
    """
    return {"status": "ok"}


@router.get("/health-check/db", response_model=HealthCheckResponse)
async def health_check_db(db: AsyncSession = Depends(get_db)):
    """
    Database health check endpoint.
    
    Returns:
        Health status of the database connection.
    """
    try:
        # Test database connection
        await db.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail={"status": "error", "database": "disconnected", "error": str(e)}
        ) from e
