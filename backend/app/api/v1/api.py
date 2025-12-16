"""
API v1 router configuration.
"""
from fastapi import APIRouter

from app.api.v1.endpoints import health_check, auth, data, search, validate

# Create main API router
api_router = APIRouter()

# Include endpoint routers
api_router.include_router(health_check.router, tags=["System"])
api_router.include_router(auth.router, prefix="/authenticate", tags=["Authentication"])
api_router.include_router(
    data.router,
    prefix="/{repository}/data",
    tags=["Public Data"],
)
api_router.include_router(
    search.router,
    prefix="/{repository}/search",
    tags=["Search"],
)
api_router.include_router(
    validate.router,
    prefix="/{repository}/validate",
    tags=["Validation"],
)

# Private endpoints (require authentication)
private_router = APIRouter()
private_router.include_router(
    data.private_router,
    prefix="/private/data",
    tags=["Private Data"],
)
private_router.include_router(
    search.private_router,
    prefix="/private/search",
    tags=["Private Search"],
)
private_router.include_router(
    validate.private_router,
    prefix="/private/validate",
    tags=["Private Validation"],
)

# Include private router with repository prefix
api_router.include_router(
    private_router,
    prefix="/{repository}",
    tags=["Private"],
)
