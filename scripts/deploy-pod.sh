#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

pod_target=${1:-cloudy@cloudy.local}

rsync -az --exclude __pycache__ --exclude '*.pyc' \
  apps/pod/cloudy_pod \
  apps/pod/deploy \
  apps/pod/pyproject.toml \
  apps/pod/requirements.lock \
  "$pod_target:/opt/cloudy-pod/"

ssh -t "$pod_target" '
  set -eu
  cd /opt/cloudy-pod

  set +e
  sudo sh deploy/provision-inmp441.sh --apply
  hardware_status=$?
  set -e
  if [ "$hardware_status" -ne 0 ] && [ "$hardware_status" -ne 10 ]; then
    exit "$hardware_status"
  fi

  if [ ! -x .venv/bin/python ]; then
    python3 -m venv .venv
  fi

  if ! cmp -s pyproject.toml .installed-pyproject.toml \
    || ! cmp -s requirements.lock .installed-requirements.lock; then
    .venv/bin/python -m pip install -c requirements.lock .
    cp pyproject.toml .installed-pyproject.toml
    cp requirements.lock .installed-requirements.lock
  fi

  sudo install -m 0644 deploy/cloudy-pod.service /etc/systemd/system/cloudy-pod.service
  sudo systemctl daemon-reload
  sudo systemctl enable cloudy-pod
  if [ "$hardware_status" -eq 10 ]; then
    sudo systemd-run --quiet --unit=cloudy-pod-hardware-reboot --on-active=3s /usr/bin/systemctl reboot
    echo "INMP441 configured; the Pi will reboot in three seconds"
    exit 0
  fi
  sudo systemctl restart cloudy-pod
  sudo systemctl is-active --quiet cloudy-pod
'

echo "Cloudy Pod updated on $pod_target"
