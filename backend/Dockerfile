FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY . .
RUN uv sync --frozen --no-dev

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

# Role is selected by the compose service command:
#   node backend:  fiesta init && uvicorn fiesta.apps.node:create_app --factory
#   public api:    fiesta init && uvicorn fiesta.apps.public:create_app --factory
#   worker:        fiesta worker
CMD ["uvicorn", "fiesta.apps.node:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
