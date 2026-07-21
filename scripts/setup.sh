#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

pnpm --dir apps/api install --frozen-lockfile
pnpm --dir apps/web install --frozen-lockfile
uv --directory apps/memory sync --extra dev --frozen

pod_python=${CLOUDY_PYTHON:-python3}
"$pod_python" -m venv apps/pod/.venv
apps/pod/.venv/bin/python -m pip install -c apps/pod/requirements.lock -e apps/pod
