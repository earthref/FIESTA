FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS runtime

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY . .
RUN uv sync --frozen --no-dev

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

# Role is selected by the compose service command:
#   api:     fiesta init && uvicorn fiesta.apps.api:create_app --factory
#   worker:  fiesta worker
CMD ["uvicorn", "fiesta.apps.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]

# Offline integration runner: dependencies are installed at image-build time.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS test
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project
COPY . .
RUN uv sync --frozen
ENV PATH="/app/.venv/bin:$PATH"
CMD ["pytest", "-q"]

# Keep the default build production-sized.
FROM runtime AS production
