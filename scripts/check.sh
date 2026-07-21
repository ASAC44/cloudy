#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

pnpm --dir apps/api test
pnpm --dir apps/api typecheck
pnpm --dir apps/web lint
pnpm --dir apps/web exec tsc --noEmit
sh -n scripts/deploy-pod.sh
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy GPIOZERO_PIN_FACTORY=mock \
  apps/pod/.venv/bin/python -m unittest discover -s apps/pod/tests -v
