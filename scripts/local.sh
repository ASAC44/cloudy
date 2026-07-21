#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo_dir"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required: https://supabase.com/docs/guides/local-development/cli/getting-started" >&2
  exit 1
fi

case "${1:-}" in
  '') ;;
  --reset) reset=1 ;;
  *) echo "Usage: $0 [--reset]" >&2; exit 2 ;;
esac

supabase start
if [ "${reset:-0}" = 1 ]; then
  supabase db reset --local
fi

status_file=$(mktemp)
trap 'rm -f "$status_file"' EXIT
supabase status -o env > "$status_file"
set -a
. "$status_file"
set +a

local_url=${API_URL:-${SUPABASE_URL:-}}
local_public_key=${PUBLISHABLE_KEY:-${ANON_KEY:-}}
local_secret_key=${SECRET_KEY:-${SERVICE_ROLE_KEY:-}}

if [ -z "$local_url" ] || [ -z "$local_public_key" ] || [ -z "$local_secret_key" ]; then
  echo "Supabase did not report the local URL and API keys." >&2
  exit 1
fi

export SUPABASE_URL="$local_url"
export SUPABASE_SECRET_KEY="$local_secret_key"
export NEXT_PUBLIC_SUPABASE_URL="$local_url"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$local_public_key"
export CLOUDY_PUBLIC_API_URL=http://localhost:3001
export CLOUDY_WEB_URL=http://localhost:3000
export CLOUDY_API_URL=http://localhost:3001

rm -f "$status_file"
trap - EXIT
exec "$repo_dir/scripts/dev.sh"
