#!/usr/bin/env bash
set -euo pipefail

command -v ngrok >/dev/null || {
  echo "ngrok is not installed"
  exit 1
}

exec ngrok http "${CLOUDY_API_PORT:-3001}"
