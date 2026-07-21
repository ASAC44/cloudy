#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo_dir"

if [ -f "$repo_dir/apps/pod/.env" ]; then
  set -a
  . "$repo_dir/apps/pod/.env"
  set +a
fi

api_pid=
worker_pid=
web_pid=
pod_pid=
memory_pid=
cleanup() {
  kill ${api_pid:+"$api_pid"} ${worker_pid:+"$worker_pid"} \
    ${web_pid:+"$web_pid"} ${pod_pid:+"$pod_pid"} \
    ${memory_pid:+"$memory_pid"} 2>/dev/null || true
}

trap cleanup EXIT INT TERM

if [ -f "$repo_dir/apps/memory/.env" ]; then
  set -a
  . "$repo_dir/apps/memory/.env"
  set +a
  MEMORY_SERVICE_URL=${MEMORY_SERVICE_URL:-http://localhost:8000}
  export MEMORY_SERVICE_URL
  "$repo_dir/scripts/start-memory.sh" &
  memory_pid=$!
else
  echo "Memory service skipped; create apps/memory/.env to start it with Cloudy"
fi

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

wait "$api_pid" "$worker_pid" "$web_pid" "$pod_pid" ${memory_pid:+"$memory_pid"}
