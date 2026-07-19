#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

cleanup() {
  kill "$api_pid" "$web_pid" "$pod_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

pnpm --dir apps/api dev &
api_pid=$!
pnpm --dir apps/web dev &
web_pid=$!
PODEX_API_URL=${PODEX_API_URL:-http://localhost:3001} \
PODEX_SIMULATOR=1 \
PODEX_STATE_DIR=${PODEX_STATE_DIR:-apps/pod/.state} \
GPIOZERO_PIN_FACTORY=mock \
  apps/pod/.venv/bin/python -m podex_pod &
pod_pid=$!

wait "$api_pid" "$web_pid" "$pod_pid"
