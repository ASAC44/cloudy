#!/bin/sh
set -eu

overlay=dtoverlay=googlevoicehat-soundcard
boot_config=${CLOUDY_BOOT_CONFIG:-/boot/firmware/config.txt}
service_user=${CLOUDY_SERVICE_USER:-cloudy}
mic_device=${CLOUDY_MIC_DEVICE:-plughw:CARD=sndrpii2scard,DEV=0}

add_overlay() {
  if grep -Eq '^[[:space:]]*dtoverlay=googlevoicehat-soundcard([[:space:]]|$)' "$1"; then
    return 1
  fi
  printf '\n# Cloudy INMP441 microphone\n%s\n' "$overlay" >> "$1"
}

self_check() {
  directory=$(mktemp -d)
  trap 'rm -rf "$directory"' EXIT HUP INT TERM
  config=$directory/config.txt
  printf 'dtparam=audio=on\n' > "$config"
  add_overlay "$config"
  if add_overlay "$config"; then
    echo "Overlay was added twice" >&2
    exit 1
  fi
  [ "$(grep -Fc "$overlay" "$config")" -eq 1 ]
  echo "INMP441 provisioner self-check passed"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run this command with sudo" >&2
    exit 1
  fi
}

check_hardware() {
  require_root
  grep -Eq '^[[:space:]]*dtoverlay=googlevoicehat-soundcard([[:space:]]|$)' "$boot_config" || {
    echo "INMP441 boot overlay is not configured" >&2
    exit 1
  }
  id "$service_user" >/dev/null
  id -nG "$service_user" | tr ' ' '\n' | grep -qx audio || {
    echo "$service_user is not in the audio group" >&2
    exit 1
  }
  arecord -l 2>&1 | grep -Fq sndrpii2scard || {
    echo "sndrpii2scard is unavailable; reboot and check the I²S wiring" >&2
    exit 1
  }
  systemctl show cloudy-pod -p SupplementaryGroups --value | tr ' ' '\n' | grep -qx audio || {
    echo "cloudy-pod.service does not have the audio supplementary group" >&2
    exit 1
  }

  capture=$(mktemp /tmp/cloudy-mic-check.XXXXXX)
  trap 'rm -f "$capture"' EXIT HUP INT TERM
  chown "$service_user" "$capture"
  echo "Speak near the INMP441 for three seconds..."
  runuser -u "$service_user" -- arecord -D "$mic_device" -q -t wav -f S16_LE -r 16000 -c 1 -d 3 "$capture"
  python3 - "$capture" <<'PY'
import array
import os
import sys
import wave

path = sys.argv[1]
with wave.open(path, "rb") as recording:
    valid = (
        recording.getnchannels() == 1
        and recording.getsampwidth() == 2
        and recording.getframerate() == 16_000
        and 0 < recording.getnframes() <= 16_000 * 3
    )
    samples = array.array("h", recording.readframes(recording.getnframes()))
if not valid or not samples or os.path.getsize(path) >= 2_000_000:
    raise SystemExit("Capture is not a valid mono 16 kHz/16-bit WAV under 2 MB")
if sys.byteorder != "little":
    samples.byteswap()
peak = max(abs(sample) for sample in samples)
if peak == 0:
    raise SystemExit("Capture contains no microphone signal")
print(f"INMP441 capture passed: {len(samples)} samples, peak {peak}, {os.path.getsize(path)} bytes")
PY
}

apply_hardware() {
  require_root
  [ -f "$boot_config" ] || {
    echo "Missing Raspberry Pi boot configuration: $boot_config" >&2
    exit 1
  }
  id "$service_user" >/dev/null
  getent group audio >/dev/null
  if ! command -v arecord >/dev/null 2>&1; then
    apt-get update
    apt-get install -y alsa-utils
  fi
  usermod -a -G audio "$service_user"
  if add_overlay "$boot_config"; then
    echo "INMP441 overlay added; reboot required"
    exit 10
  fi
  if ! arecord -l 2>&1 | grep -Fq sndrpii2scard; then
    echo "INMP441 overlay is configured but not loaded; reboot required"
    exit 10
  fi
  echo "INMP441 hardware provisioning is active"
}

case ${1:---apply} in
  --apply) apply_hardware ;;
  --check) check_hardware ;;
  --self-check) self_check ;;
  *) echo "Usage: $0 [--apply|--check|--self-check]" >&2; exit 2 ;;
esac
