#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for the optional ARM64 Pod check." >&2
  exit 2
fi

docker run --rm \
  --platform linux/arm64 \
  --memory 512m \
  --cpus 4 \
  -e SDL_VIDEODRIVER=dummy \
  -e SDL_AUDIODRIVER=dummy \
  -e GPIOZERO_PIN_FACTORY=mock \
  -v "$PWD/apps/pod:/app" \
  -w /app \
  python:3.13-slim-trixie \
  sh -c 'python -m pip install -c requirements.lock . && python -m unittest discover -s tests -v'
