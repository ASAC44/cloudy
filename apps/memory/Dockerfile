FROM ghcr.io/astral-sh/uv:0.11.28 AS uv
FROM python:3.13-slim

ENV GRAPHITI_TELEMETRY_ENABLED=false \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY cloudy_memory ./cloudy_memory
RUN uv sync --frozen --no-dev

CMD ["sh", "-c", "uv run --no-sync uvicorn cloudy_memory.app:configured_app --factory --host 0.0.0.0 --port ${PORT:-8000}"]
