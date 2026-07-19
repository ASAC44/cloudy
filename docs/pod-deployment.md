# Deploy the Pod to Raspberry Pi Zero 2 W

## Provision the Pi

Flash Raspberry Pi OS Lite 64-bit with Raspberry Pi Imager. Configure Wi-Fi,
hostname, a `podex` user, and public-key SSH access in Imager. After boot:

```sh
sudo apt update
sudo apt full-upgrade
sudo apt install cage python3-venv python3-pip
sudo usermod -a -G input,render,video,gpio podex
sudo mkdir -p /opt/podex-pod /var/lib/podex-pod
sudo chown -R podex:podex /opt/podex-pod /var/lib/podex-pod
python3 --version # must report Python 3.13.x
```

Use the current 64-bit Raspberry Pi OS Lite image that provides Python 3.13;
do not silently deploy this runtime on an older Python release.

Configure the selected HDMI/KMS display and I²C capacitive touch controller
using its current Raspberry Pi OS instructions. Do not install a vendor OS
image or legacy framebuffer-copy stack when a KMS/DRM driver is available.

## Copy and install

From the development computer:

```sh
rsync -az apps/pod/ podex@podex.local:/opt/podex-pod/
ssh podex@podex.local '
  cd /opt/podex-pod &&
  python3 -m venv .venv &&
  .venv/bin/python -m pip install -c requirements.lock .
'
scp apps/pod/deploy/podex-pod.service podex@podex.local:/tmp/
```

On the Pi, create `/etc/podex-pod.env`:

```dotenv
PODEX_API_URL=https://your-api-domain.example
PODEX_STATE_DIR=/var/lib/podex-pod
PODEX_APPROVE_PIN=5
PODEX_REJECT_PIN=6
```

Then install and start the kiosk service:

```sh
sudo install -m 0644 /tmp/podex-pod.service /etc/systemd/system/podex-pod.service
sudo chmod 0600 /etc/podex-pod.env
sudo systemctl daemon-reload
sudo systemctl enable --now podex-pod
journalctl -u podex-pod -f
```

The service runs Cage directly on tty1, restarts after failures, and launches
the same pygame code used by the simulator. The Pod API token remains on the
Pi; Supabase and integration secrets never do.

## Hardware acceptance

Before treating the image as production-ready, verify:

- 640×480 landscape output, color, brightness, rotation, and screen blanking.
- Touch coordinates, swipe direction, and physical text/button legibility.
- GPIO5 Approve and GPIO6 Reject wiring, pull-ups, debounce, and enclosure fit.
- Boot-to-kiosk behavior and clean restart after power loss.
- Wi-Fi loss/recovery and read-only cached request behavior.
- Frame timing, memory, temperature, and power stability during a long run.

Microphone and dictation validation are deferred until that feature is added.
