#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo_dir"

cleanup() {
  kill "$api_pid" "$worker_pid" "$web_pid" "$pod_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

CLOUDY_LOCAL_LAYOUT_DB="$repo_dir/apps/api/.state/cloudy.sqlite" pnpm --dir apps/api dev &
api_pid=$!
pnpm --dir apps/api dev:worker &
worker_pid=$!
pnpm --dir apps/web dev &
web_pid=$!
CLOUDY_API_URL=${CLOUDY_API_URL:-http://localhost:3001} \
CLOUDY_SIMULATOR=1 \
CLOUDY_STATE_DIR=${CLOUDY_STATE_DIR:-apps/pod/.state} \
GPIOZERO_PIN_FACTORY=mock \
  apps/pod/.venv/bin/python -m cloudy_pod &
pod_pid=$!

wait "$api_pid" "$worker_pid" "$web_pid" "$pod_pid"
