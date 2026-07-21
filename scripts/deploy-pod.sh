#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

pod_target=${1:-cloudy@cloudy.local}

rsync -az --exclude __pycache__ --exclude '*.pyc' \
  apps/pod/cloudy_pod \
  apps/pod/pyproject.toml \
  apps/pod/requirements.lock \
  "$pod_target:/opt/cloudy-pod/"

ssh -t "$pod_target" '
  set -eu
  cd /opt/cloudy-pod

  if [ ! -x .venv/bin/python ]; then
    python3 -m venv .venv
  fi

  if ! cmp -s pyproject.toml .installed-pyproject.toml \
    || ! cmp -s requirements.lock .installed-requirements.lock; then
    .venv/bin/python -m pip install -c requirements.lock .
    cp pyproject.toml .installed-pyproject.toml
    cp requirements.lock .installed-requirements.lock
  fi

  sudo systemctl restart cloudy-pod
  sudo systemctl is-active --quiet cloudy-pod
'

echo "Cloudy Pod updated on $pod_target"
