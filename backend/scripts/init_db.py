"""
Initialize the database.
"""
import asyncio
import logging
import os
import sys
from pathlib import Path

# Add the app directory to the Python path
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import select

from app.core.config import settings
from app.db.session import Base, engine, AsyncSessionLocal
from app.db.models.user import User
from app.db.models.contribution import Contribution, ContributionHistory
from app.core.security import get_password_hash

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def init_db() -> None:
    """Initialize the database with tables and initial data."""
    logger.info("Creating database tables...")
    
    # Create tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    logger.info("Database tables created.")
    
    # Create initial admin user if it doesn't exist
    async with AsyncSessionLocal() as db:
        # Check if admin user exists
        result = await db.execute(select(User).where(User.email == "admin@example.com"))
        admin = result.scalars().first()
        
        if not admin:
            logger.info("Creating initial admin user...")
            admin = User(
                email="admin@example.com",
                hashed_password=get_password_hash("changeme"),
                full_name="Admin User",
                is_active=True,
                is_superuser=True,
            )
            db.add(admin)
            await db.commit()
            logger.info("Initial admin user created with email: admin@example.com and password: changeme")
        else:
            logger.info("Admin user already exists.")
    
    logger.info("Database initialization complete.")


if __name__ == "__main__":
    logger.info("Starting database initialization...")
    asyncio.run(init_db())
