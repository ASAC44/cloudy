#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo_dir"

if [ -f "$repo_dir/apps/pod/.env" ]; then
  set -a
  . "$repo_dir/apps/pod/.env"
  set +a
fi

cleanup() {
  kill "$api_pid" "$worker_pid" "$web_pid" "$pod_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

PODEX_LOCAL_LAYOUT_DB="$repo_dir/apps/api/.state/podex.sqlite" pnpm --dir apps/api dev &
api_pid=$!
pnpm --dir apps/api dev:worker &
worker_pid=$!
pnpm --dir apps/web dev &
web_pid=$!
PODEX_API_URL=${PODEX_API_URL:-http://localhost:3001} \
PODEX_SIMULATOR=${PODEX_SIMULATOR:-1} \
PODEX_STATE_DIR=${PODEX_STATE_DIR:-apps/pod/.state} \
GPIOZERO_PIN_FACTORY=${GPIOZERO_PIN_FACTORY:-mock} \
  apps/pod/.venv/bin/python -m podex_pod &
pod_pid=$!

wait "$api_pid" "$worker_pid" "$web_pid" "$pod_pid"
