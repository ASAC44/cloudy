#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

pnpm --dir apps/api install --frozen-lockfile
pnpm --dir apps/web install --frozen-lockfile

pod_python=${PODEX_PYTHON:-python3}
"$pod_python" -m venv apps/pod/.venv
apps/pod/.venv/bin/python -m pip install -c apps/pod/requirements.lock -e apps/pod
