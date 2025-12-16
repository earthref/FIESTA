"""
Run the FastAPI application.
"""
import uvicorn
from pathlib import Path
import sys

# Add the app directory to the Python path
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.config import settings

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.APP_DEBUG,
        log_level="info" if settings.APP_DEBUG else "warning",
    )
