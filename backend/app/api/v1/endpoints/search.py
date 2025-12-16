"""
Search endpoints for public and private data.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_active_user
from app.db.session import get_db
from app.schemas.data import DataSearchResult, RepositoryEnum
from app.schemas.token import UserResponse

# Create routers
router = APIRouter()
private_router = APIRouter(dependencies=[Depends(get_current_active_user)])

# Public endpoints


@router.get("/{table}", response_model=DataSearchResult)
async def search_table(
    table: str,
    repository: RepositoryEnum,
    q: str = Query("*", description="Search query"),
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(10, ge=1, le=100, description="Items per page"),
    sort: Optional[str] = Query(None, description="Sort field and direction, e.g., 'field:asc' or 'field:desc'"),
    filters: Optional[str] = Query(None, description="Filter conditions in format 'field:value,field2:value2'"),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """
    Search data in a specific table.
    """
    # TODO: Implement actual table search
    # This is a placeholder implementation
    return {
        "total": 1,
        "items": [
            {
                "id": 1,
                "repository": repository.value,
                "table": table,
                "data": {"id": 1, "name": f"Sample {table.capitalize()} 1"},
            }
        ],
    }


# Private endpoints


@private_router.get("/private/{table}", response_model=DataSearchResult)
async def search_private_table(
    table: str,
    repository: RepositoryEnum,
    q: str = Query("*", description="Search query"),
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(10, ge=1, le=100, description="Items per page"),
    sort: Optional[str] = Query(None, description="Sort field and direction"),
    filters: Optional[str] = Query(None, description="Filter conditions"),
    db: AsyncSession = Depends(get_db),
    current_user: UserResponse = Depends(get_current_active_user),
) -> Any:
    """
    Search private data in a specific table.
    """
    # TODO: Implement actual private table search
    # This is a placeholder implementation
    return {
        "total": 1,
        "items": [
            {
                "id": 1,
                "repository": repository.value,
                "table": table,
                "data": {"id": 1, "name": f"Private {table.capitalize()} 1"},
                "created_by": current_user.id,
            }
        ],
    }
