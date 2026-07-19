import os
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
os.environ.setdefault("GPIOZERO_PIN_FACTORY", "mock")

import queue
import stat
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pygame
from gpiozero import Button, Device
from gpiozero.pins.mock import MockFactory

from podex_pod.app import BACKGROUND, INK, PodApp, idle_pose, wrap
from podex_pod.client import ApiError
from podex_pod.storage import Storage
from podex_pod.worker import PodWorker


REQUEST = {
    "id": "00000000-0000-4000-8000-000000000002",
    "title": "Send the release announcement after final review",
    "source": "Dashboard · Test Ping",
    "summary": "Confirm that this representative request is safe to approve.",
    "details": "The text is intentionally long enough to exercise wrapping and scrolling on the landscape screen.",
    "affected_context": "Test data only",
    "risk": "medium",
    "warnings": ["No external action will run."],
    "payload_hash": "a" * 64,
    "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
}


class FakeWorker:
    def __init__(self):
        self.events = queue.SimpleQueue()
        self.decisions = []
        self.offline = False

    def decide(self, request, outcome):
        self.decisions.append((request["id"], outcome))

    def set_offline(self, offline):
        self.offline = offline


class PodTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.storage = Storage(Path(self.temp.name))
        self.worker = FakeWorker()
        self.app = PodApp(self.worker, self.storage, simulator=True)

    def tearDown(self):
        pygame.display.quit()
        self.temp.cleanup()

    def test_credentials_and_request_survive_restart(self):
        self.storage.save_credentials("pod_token")
        self.storage.save_request(REQUEST)
        restarted = Storage(Path(self.temp.name))

        self.assertEqual(restarted.credentials(), {"token": "pod_token"})
        self.assertEqual(restarted.request()["id"], REQUEST["id"])
        self.assertEqual(stat.S_IMODE(restarted.credentials_path.stat().st_mode), 0o600)

    def test_long_text_wraps_within_width(self):
        lines = wrap(self.app.font, "one two three four five six seven", 80)
        self.assertGreater(len(lines), 1)
        self.assertTrue(all(self.app.font.size(line)[0] <= 80 for line in lines))

    def test_primary_states_render_at_device_resolution(self):
        self.assertEqual(pygame.display.get_window_size(), (640, 480))
        for state in ("startup", "pairing", "idle", "request", "offline", "submitting", "approved", "rejected", "expired", "revoked", "error"):
            self.app.state = state
            self.app.pairing_code = "ABCD1234"
            self.app.request = REQUEST if state in ("request", "offline", "expired") else None
            self.assertEqual(self.app.render().get_size(), (640, 480), state)
        self.assertLess(sum(BACKGROUND[:3]), 120)

    def test_startup_is_pitch_black_with_an_animated_loader(self):
        self.app.state = "startup"
        with patch("pygame.time.get_ticks", side_effect=(0, 350)):
            first_frame = self.app.render().copy()
            second_frame = self.app.render().copy()

        self.assertEqual(BACKGROUND, pygame.Color("#000000"))
        self.assertEqual(INK, pygame.Color("#ffffff"))
        self.assertNotEqual(pygame.image.tobytes(first_frame, "RGB"), pygame.image.tobytes(second_frame, "RGB"))

    def test_idle_pose_floats_breathes_and_blinks(self):
        resting = idle_pose(0)
        floating = idle_pose(1.25)
        blinking = idle_pose(3.8)

        self.assertEqual(resting, (0, 184, False))
        self.assertGreater(floating[0], resting[0])
        self.assertNotEqual(floating[1], resting[1])
        self.assertTrue(blinking[2])

    def test_offline_mode_blocks_decisions(self):
        self.app.state = "request"
        self.app.request = REQUEST
        self.app.toggle_offline()
        self.app.choose("approved")
        self.assertEqual(self.worker.decisions, [])

    def test_expired_request_blocks_decisions(self):
        self.app.state = "request"
        self.app.request = {**REQUEST, "expires_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
        self.app.choose("approved")
        self.assertEqual(self.worker.decisions, [])
        self.assertEqual(self.app.state, "expired")

    def test_keyboard_and_gpio_use_the_same_decision_action(self):
        self.app.state = "request"
        self.app.request = REQUEST
        self.app.handle_event(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_a))
        self.assertEqual(self.worker.decisions[-1][1], "approved")

        self.app.state = "request"
        Device.pin_factory = MockFactory()
        button = Button(6)
        button.when_pressed = lambda: self.app.choose("rejected")
        button.pin.drive_low()
        self.assertEqual(self.worker.decisions[-1][1], "rejected")
        button.close()

    def test_mouse_and_touch_input_normalize_and_scroll(self):
        self.assertEqual(self.app.logical_point((320, 238)), (320, 238))
        self.assertIsNone(self.app.logical_point((700, 500)))
        self.app.scroll = 100
        self.app.handle_event(pygame.event.Event(pygame.FINGERMOTION, dy=0.1))
        self.assertEqual(self.app.scroll, 52)

    def test_revoked_credentials_and_cache_return_to_pairing(self):
        class RevokedClient:
            def current_request(self, _token):
                raise ApiError(401, "Unauthorized")

        self.storage.save_credentials("pod_token")
        self.storage.save_request(REQUEST)
        worker = PodWorker(RevokedClient(), self.storage, poll_seconds=0.01)
        worker.start()
        event = worker.events.get(timeout=1)
        worker.close()
        worker.join(timeout=1)
        self.assertEqual(event["event"], "revoked")
        self.assertIsNone(self.storage.credentials())
        self.assertIsNone(self.storage.request())

    def test_worker_events_update_pairing_and_request_state(self):
        self.worker.events.put({"event": "pairing", "pairing_code": "ABCD1234"})
        self.worker.events.put({"event": "idle"})
        self.app.apply_worker_events()
        self.assertEqual(self.app.state, "idle")

        self.worker.events.put({"event": "request", "request": REQUEST, "queue_size": 2})
        self.app.apply_worker_events()
        self.assertEqual(self.app.state, "request")
        self.assertEqual(self.app.queue_size, 2)

    def test_reconnecting_reemits_the_cached_request(self):
        class RequestClient:
            def current_request(self, _token):
                return {"request": REQUEST, "queue_size": 1}

        self.storage.save_credentials("pod_token")
        worker = PodWorker(RequestClient(), self.storage, poll_seconds=0.01)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1)["event"], "request")

        worker.set_offline(True)
        self.assertEqual(worker.events.get(timeout=1)["event"], "offline")
        worker.set_offline(False)
        self.assertEqual(worker.events.get(timeout=1)["event"], "reconnecting")
        self.assertEqual(worker.events.get(timeout=1)["event"], "request")

        worker.close()
        worker.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
