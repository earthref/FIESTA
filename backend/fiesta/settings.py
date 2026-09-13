"""Environment settings (infrastructure/secrets).

Node identity, data model, branding, etc. live in the deployment YAML
(see fiesta.nodeconfig); this module only covers where the infrastructure
lives and credentials — the parts that differ between environments, not
between nodes.
"""

import ssl
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL, make_url

# libpq connection parameters that asyncpg does not accept as keyword
# arguments. They are honoured by translating them in sqlalchemy_connect_args()
# (or, for procrastinate, by handing the URL to psycopg/libpq unchanged).
_LIBPQ_ONLY = {
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "sslcrl",
    "sslsni",
    "sslcompression",
    "sslminprotocolversion",
    "sslmaxprotocolversion",
    "channel_binding",
    "gssencmode",
    "target_session_attrs",
    "connect_timeout",
    "application_name",
    "options",
    "passfile",
    "hostaddr",
    "service",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FIESTA_", env_file=".env", extra="ignore")

    environment: str = "production"

    # The deployment YAML: `config/fiesta.yaml` lists every node one API
    # process serves. FIESTA_NODE (comma-separated keys or slugs) narrows it
    # for a local stack; empty means every node in the file.
    config_file: Path = Path("../config/fiesta.yaml")
    node: str = ""

    # Postgres. Either SQLAlchemy form (postgresql+asyncpg://...) or a plain
    # libpq URL as used by psql (postgresql://...?sslmode=verify-full&
    # sslrootcert=system&target_session_attrs=read-write); both work.
    database_url: str = "postgresql+asyncpg://fiesta:fiesta@localhost:5432/fiesta"
    # Schema holding the tables shared by every node (user accounts). Each
    # node's own tables live in a schema named after its slug (magic, cdr, ...).
    db_shared_schema: str = "public"

    # OpenSearch. Credentials and TLS come from the URL
    # (https://user:pass@host:9400); verification uses the system CA bundle
    # unless opensearch_ca_certs points at a file.
    opensearch_url: str = "http://localhost:9200"
    opensearch_verify_certs: bool = True
    opensearch_ca_certs: str | None = None
    # Prepended to every node's `search.index` (fiesta- -> fiesta-magic). Use it
    # when FIESTA shares a cluster with other applications: `fiesta rebuild`
    # deletes and recreates the node's index, so the name must be FIESTA's own.
    index_prefix: str = ""

    # S3. s3_endpoint is set for MinIO / other S3-compatible stores and left
    # empty for AWS itself. With s3_bucket set, every node stores its objects
    # in that one bucket under a "<slug>/" key prefix instead of the per-node
    # bucket named in its YAML (AWS bucket names are global, so "magic" is not
    # available there).
    s3_endpoint: str | None = "http://localhost:9000"
    s3_access_key: str = "fiesta"
    s3_secret_key: str = "fiesta-secret"
    s3_region: str = "us-east-1"
    s3_bucket: str | None = None

    secret_key: str = "change-me"
    access_token_expire_minutes: int = 60 * 24

    smtp_host: str = "localhost"
    smtp_port: int = 1025
    smtp_from: str = "noreply@earthref.org"

    cors_origins: list[str] = ["http://localhost:5173"]

    # Path prefix the API is published under when a reverse proxy strips one
    # before the request reaches uvicorn (routes stay at /v2); this only tells
    # FastAPI where to advertise /v2/docs and openapi.json. "" or "/" means the
    # API owns the hostname (api.earthref.org).
    root_path: str = ""

    # Local-dev only: `slug=url,slug=url` overrides for sibling FIESTA nodes'
    # portal-bar links so a multi-node stack cross-links to the running
    # localhost instances. Empty in production (real hostnames route instead).
    portal_urls: str = ""

    @field_validator("s3_endpoint", "s3_bucket", "opensearch_ca_certs", mode="before")
    @classmethod
    def _empty_is_none(cls, value):
        """FIESTA_S3_ENDPOINT= (empty) in an env file means "unset"."""
        return None if isinstance(value, str) and not value.strip() else value

    @property
    def fastapi_root_path(self) -> str:
        """root_path in the form FastAPI expects: no trailing slash, "" for root."""
        return "/" + self.root_path.strip("/") if self.root_path.strip("/") else ""

    @property
    def sqlalchemy_url(self) -> URL:
        """database_url as an asyncpg SQLAlchemy URL, minus libpq-only params."""
        url = make_url(self.database_url).set(drivername="postgresql+asyncpg")
        return url.set(query={k: v for k, v in url.query.items() if k not in _LIBPQ_ONLY})

    def sqlalchemy_connect_args(self) -> dict:
        """asyncpg connect kwargs equivalent to the libpq params in database_url.

        sslmode=verify-full with sslrootcert=system (libpq 16+) becomes an
        SSLContext built from the system CA bundle with hostname checking;
        a file path for sslrootcert is loaded on top of it."""
        query = make_url(self.database_url).query
        args: dict = {}
        sslmode = query.get("sslmode")
        rootcert = query.get("sslrootcert")
        if sslmode == "disable":
            args["ssl"] = False
        elif sslmode in ("verify-ca", "verify-full"):
            ctx = ssl.create_default_context()
            if rootcert and rootcert != "system":
                ctx.load_verify_locations(cafile=rootcert)
            ctx.check_hostname = sslmode == "verify-full"
            ctx.verify_mode = ssl.CERT_REQUIRED
            args["ssl"] = ctx
        elif sslmode == "require":
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            args["ssl"] = ctx
        elif sslmode in ("allow", "prefer"):
            args["ssl"] = sslmode
        if "target_session_attrs" in query:
            args["target_session_attrs"] = query["target_session_attrs"]
        if "connect_timeout" in query:
            args["timeout"] = float(query["connect_timeout"])
        if "application_name" in query:
            args["server_settings"] = {"application_name": query["application_name"]}
        return args

    @property
    def procrastinate_dsn(self) -> str:
        """Procrastinate connects with psycopg (libpq), which understands the
        libpq params natively; only the SQLAlchemy driver suffix is dropped."""
        return self.database_url.replace("postgresql+asyncpg://", "postgresql://")

    def portal_url_map(self) -> dict[str, str]:
        result: dict[str, str] = {}
        for pair in self.portal_urls.split(","):
            slug, _, url = pair.partition("=")
            if slug.strip() and url.strip():
                result[slug.strip().lower()] = url.strip()
        return result


@lru_cache
def get_settings() -> Settings:
    return Settings()
