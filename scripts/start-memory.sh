#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
memory_dir="$repo_dir/apps/memory"
memory_env="$memory_dir/.env"

if [ ! -f "$memory_env" ]; then
  echo "Memory environment is missing; copy apps/memory/.env.example to apps/memory/.env" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to start the local Neo4j memory database" >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required; run ./scripts/setup.sh after installing it" >&2
  exit 1
fi

docker compose --env-file "$memory_env" -f "$memory_dir/compose.yaml" up -d --wait neo4j
exec uv --directory "$memory_dir" run --env-file "$memory_env" \
  uvicorn cloudy_memory.app:configured_app --factory --reload --port 8000
