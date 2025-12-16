"""
Application configuration settings.
"""
from functools import lru_cache
from typing import List, Optional, Union
import json

from pydantic import AnyHttpUrl, validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Application
    APP_ENV: str = "development"
    APP_SECRET_KEY: str
    APP_DEBUG: bool = False

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Database
    DATABASE_URL: str
    DATABASE_TEST_URL: str = ""
    TESTING: bool = False

    # Security
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30

    # AWS S3
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_REGION: str = "us-west-2"
    S3_BUCKET_NAME: str = "fiesta-uploads"

    # Elasticsearch
    ELASTICSEARCH_HOST: str = "http://localhost:9200"

    # CORS
    BACKEND_CORS_ORIGINS: List[AnyHttpUrl] = [
        "http://localhost:3000",
        "http://localhost:8000",
    ]

    @validator("BACKEND_CORS_ORIGINS", pre=True)
    def parse_cors_origins(cls, v: Union[str, List[str]]) -> List[str]:
        if isinstance(v, str):
            if v.startswith("["):
                return json.loads(v)
            return [i.strip() for i in v.split(",")]
        return v

    class Config:
        env_file = ".env"
        case_sensitive = True
        env_prefix = ""


@lru_cache()
def get_settings() -> Settings:
    """
    Get the application settings.
    
    This function is cached to prevent reading the .env file multiple times.
    """
    return Settings()


# Global settings object
settings = get_settings()