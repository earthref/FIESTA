"""
Pydantic schemas for health check endpoints.
"""
from typing import Dict, Any, Optional
from pydantic import BaseModel, Field


class HealthCheckResponse(BaseModel):
    """Response model for health check endpoints."""
    status: str = Field(..., description="Status of the service")
    database: Optional[str] = Field(None, description="Database connection status")
    error: Optional[str] = Field(None, description="Error message if any")
    
    class Config:
        schema_extra = {
            "example": {
                "status": "ok",
                "database": "connected"
            }
        }
