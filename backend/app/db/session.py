"""
Database session management.
"""
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.pool import NullPool

from app.core.config import settings

# Create async engine
engine = create_async_engine(
    settings.DATABASE_URL if not settings.TESTING else settings.DATABASE_TEST_URL,
    echo=settings.APP_DEBUG,
    pool_pre_ping=True,
    poolclass=NullPool if settings.TESTING else None,
)

# Create async session factory
AsyncSessionLocal = sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)

# Base class for models
Base = declarative_base()


async def get_db() -> AsyncSession:
    """
    Dependency function that yields database sessions.
    
    Usage in FastAPI path operations:
    ```python
    async def some_endpoint(db: AsyncSession = Depends(get_db)):
        # Use db session
        pass
    ```
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
