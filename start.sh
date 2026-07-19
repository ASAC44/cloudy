#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cd "$repo_dir"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required; install pnpm 11, then run ./scripts/setup.sh" >&2
  exit 1
fi

if [ ! -x apps/pod/.venv/bin/python ]; then
  echo "Pod environment is missing; run ./scripts/setup.sh first" >&2
  exit 1
fi

exec "$repo_dir/scripts/dev.sh"
