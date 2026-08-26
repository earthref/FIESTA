"""Environment settings (infrastructure/secrets).

Node identity, data model, branding, etc. live in the deployment YAML
(see fiesta.nodeconfig); this module only covers where the infrastructure
lives and credentials — the parts that differ between environments, not
between nodes.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FIESTA_", env_file=".env", extra="ignore")

    config_file: Path = Path("../config/magic.yaml")

    database_url: str = "postgresql+asyncpg://fiesta:fiesta@localhost:5432/fiesta"
    opensearch_url: str = "http://localhost:9200"

    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "fiesta"
    s3_secret_key: str = "fiesta-secret"
    s3_region: str = "us-east-1"

    secret_key: str = "change-me"
    access_token_expire_minutes: int = 60 * 24

    smtp_host: str = "localhost"
    smtp_port: int = 1025
    smtp_from: str = "noreply@earthref.org"

    cors_origins: list[str] = ["http://localhost:5173"]

    @property
    def procrastinate_dsn(self) -> str:
        """Procrastinate connects with psycopg, not asyncpg."""
        return self.database_url.replace("postgresql+asyncpg://", "postgresql://")


@lru_cache
def get_settings() -> Settings:
    return Settings()
