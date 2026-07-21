#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

pnpm --dir apps/api test
pnpm --dir apps/api typecheck
node scripts/check-n8n-workflow.mjs
pnpm --dir apps/web lint
pnpm --dir apps/web exec tsc --noEmit
uv --directory apps/memory run --extra dev ruff check .
uv --directory apps/memory run --extra dev pyright
uv --directory apps/memory run --extra dev pytest -q
sh -n scripts/deploy-pod.sh
sh -n apps/pod/deploy/provision-inmp441.sh
sh apps/pod/deploy/provision-inmp441.sh --self-check
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy GPIOZERO_PIN_FACTORY=mock \
  apps/pod/.venv/bin/python -m unittest discover -s apps/pod/tests -v
