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

from podex_pod.app import BACKGROUND, INK, PodApp, idle_pose, wrap, yawn_openness
from podex_pod.audio import ButtonChord, Recorder
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

GITHUB_REQUEST = {
    **REQUEST,
    "title": "#482 · Add payment retries",
    "source": "GitHub · PR merge",
    "action_payload": {"kind": "ping_rule_action", "event_id": "event-1"},
    "presentation": {
        "kind": "github_pr_v1",
        "context": "podex/api · feature/payment-retries → main",
        "facts": [
            ["AUTHOR", "vimzh"], ["FILES", "14"], ["DIFF", "+184/-39"], ["CHECKS", "12/12"],
            ["REVIEWS", "2"], ["AREA", "api"], ["MERGE", "Squash"], ["EXPIRES", "18:45 UTC"],
        ],
        "summary": "Adds bounded payment retries and backoff, updates failure handling, preserves idempotency, and adds monitoring for exhausted attempts.",
        "glance_details": [["SAFETY", "Exact reviewed SHA required"], ["ROLLBACK", "Revert merge commit"]],
        "details": [["DECISION REQUESTED", "Merge the reviewed commit."], ["REVIEW EVIDENCE", "All required checks and reviews passed."]],
        "ai_available": True,
    },
}

EMAIL_REQUEST = {
    **REQUEST,
    "title": "Tomorrow's project review",
    "source": "Gmail",
    "action_payload": {"kind": "ping_rule_action", "event_id": "event-2"},
    "presentation": {
        "kind": "email_reply_v1",
        "sender": "ava@northstar.studio",
        "time": "09:42",
        "subject": "Tomorrow's project review",
        "summary": "Ava wants to move tomorrow's project review to 3:30 PM and needs a new calendar invite.",
        "email": "Hi Vansh,\n\nCould we move tomorrow's project review to 3:30 PM?\n\nThanks,\nAva",
        "response": "Absolutely — 3:30 PM works for me. I've moved the meeting and sent an updated invite.",
    },
}

GMAIL_NOTIFICATION = {
    **REQUEST,
    "title": "Tomorrow's project review",
    "source": "Gmail",
    "presentation": {
        "kind": "gmail_notification_v1",
        "sender": "ava@northstar.studio",
        "time": "09:42",
        "subject": "Tomorrow's project review",
        "summary": "A new incoming Gmail message matched this Ping.",
        "email": "Hi Vansh,\n\nCould we move tomorrow's project review to 3:30 PM?\n\nThanks,\nAva",
    },
}


class FakeWorker:
    def __init__(self):
        self.events = queue.SimpleQueue()
        self.decisions = []
        self.offline = False
        self.transcriptions = []
        self.prompts = []

    def decide(self, request, outcome):
        self.decisions.append((request["id"], outcome))

    def set_offline(self, offline):
        self.offline = offline

    def transcribe(self, path):
        self.transcriptions.append(path)

    def prompt(self, prompt, revision, replace_request=None):
        self.prompts.append((prompt, revision, replace_request))


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

    def test_quick_settings_survive_restart(self):
        self.storage.save_settings({"brightness": 50, "volume": 75, "reduce_motion": True, "idle_animation_seconds": 60})
        restarted = PodApp(self.worker, Storage(Path(self.temp.name)), simulator=True)

        self.assertEqual((restarted.brightness, restarted.volume, restarted.reduce_motion, restarted.idle_animation_seconds), (50, 75, True, 60))

    def test_long_text_wraps_within_width(self):
        lines = wrap(self.app.font, "one two three four five six seven", 80)
        self.assertGreater(len(lines), 1)
        self.assertTrue(all(self.app.font.size(line)[0] <= 80 for line in lines))

    def test_body_typography_is_shared_across_pod_screens(self):
        self.assertIs(self.app.review_body, self.app.font)
        self.assertIs(self.app.review_detail, self.app.font)
        self.assertIs(self.app.review_label, self.app.small)

    def test_glance_summary_truncates_after_six_lines(self):
        lines = wrap(self.app.review_detail, "word " * 200, 580, max_lines=6)

        self.assertEqual(len(lines), 6)
        self.assertTrue(lines[-1].endswith("…"))
        self.assertTrue(all(self.app.review_detail.size(line)[0] <= 580 for line in lines))

    def test_primary_states_render_at_device_resolution(self):
        self.assertEqual(pygame.display.get_window_size(), (640, 480))
        for state in ("startup", "pairing", "idle", "target_unavailable", "request", "offline", "submitting", "approved", "rejected", "expired", "revoked", "error"):
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
        blinking = idle_pose(2.9)

        self.assertEqual(resting, (0, 248, False))
        self.assertNotEqual(resting[:2], idle_pose(1 / 30)[:2])
        self.assertGreater(floating[0], resting[0])
        self.assertNotEqual(floating[1], resting[1])
        self.assertTrue(blinking[2])

    def test_screen_two_is_default_and_mascot_waits_for_inactivity(self):
        with patch.object(self.app, "_render_idle", wraps=self.app._render_idle) as render_idle:
            self.app.state = "idle"
            self.app.screen = "home"
            self.app.last_interaction_at = 100
            with patch("podex_pod.app.time.monotonic", return_value=110):
                self.app.render()
            render_idle.assert_not_called()
            with patch("podex_pod.app.time.monotonic", return_value=131):
                self.app.render()
            self.app.state = "request"
            self.app.request = REQUEST
            with patch("podex_pod.app.time.monotonic", return_value=200):
                self.app.render()

        render_idle.assert_called_once()

    def test_approve_while_idle_triggers_one_second_yawn(self):
        self.app.state = "idle"
        with patch("podex_pod.app.time.monotonic", return_value=100):
            self.app.choose("approved")

        self.assertEqual(self.worker.decisions, [])
        self.assertEqual(self.app.last_interaction_at, 100)
        self.assertEqual(yawn_openness(0), 0)
        self.assertEqual(yawn_openness(0.5), 1)
        self.assertEqual(yawn_openness(1), 0)

    def test_github_demo_is_read_only(self):
        with patch.dict(os.environ, {"PODEX_DEMO": "github-pr"}):
            demo = PodApp(self.worker, self.storage, simulator=True)

        demo.choose("approved")
        self.assertEqual(demo.state, "request")
        self.assertEqual(demo.request["source"], "GitHub · PR merge")
        self.assertEqual(self.worker.decisions, [])
        with patch("pygame.time.get_ticks", return_value=0):
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 180)))
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 430)))
        with patch("pygame.time.get_ticks", return_value=300):
            demo.render()
        self.assertEqual(demo.review_page, 1)
        self.assertGreater(demo.detail_scroll_limit, 0)
        demo.handle_event(pygame.event.Event(pygame.MOUSEWHEEL, y=-1))
        self.assertEqual(demo.detail_scroll, 40)
        demo.detail_scroll = 0
        with patch("pygame.time.get_ticks", return_value=0):
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 400)))
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 180)))
        with patch("pygame.time.get_ticks", return_value=300):
            demo.render()
        self.assertEqual(demo.review_page, 0)

    def test_production_github_presentation_renders_swipes_and_decides(self):
        self.app.state = "request"
        self.app.request = GITHUB_REQUEST
        self.assertEqual(self.app.render().get_size(), (640, 480))
        with patch("pygame.time.get_ticks", return_value=0):
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 180)))
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 430)))
        with patch("pygame.time.get_ticks", return_value=300):
            self.app.render()
        self.assertEqual(self.app.review_page, 1)
        self.app.choose("approved")
        self.assertEqual(self.worker.decisions[-1], (GITHUB_REQUEST["id"], "approved"))
        self.assertEqual(self.app.state, "submitting")

    def test_email_chat_demo_uses_local_approve_and_reject_flow(self):
        with patch.dict(os.environ, {"PODEX_DEMO": "email-chat"}):
            demo = PodApp(self.worker, self.storage, simulator=True)

        self.assertEqual(demo.state, "email_chat")
        self.assertEqual(demo.render().get_size(), (640, 480))
        with patch("pygame.time.get_ticks", return_value=0):
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 180)))
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 430)))
        with patch("pygame.time.get_ticks", return_value=300):
            demo.render()
        self.assertEqual(demo.review_page, 1)
        demo.choose("approved")
        self.assertEqual(demo.state, "email_sent")
        self.assertEqual(self.worker.decisions, [])
        demo.choose("approved")
        self.assertEqual(demo.state, "email_chat")
        self.assertEqual(demo.review_page, 0)
        demo.choose("rejected")
        self.assertEqual(demo.state, "email_discarded")
        self.assertEqual(demo.render().get_size(), (640, 480))

    def test_production_email_presentation_renders_swipes_and_decides(self):
        self.app.state = "request"
        self.app.request = EMAIL_REQUEST
        self.assertEqual(self.app.render().get_size(), (640, 480))
        with patch("pygame.time.get_ticks", return_value=0):
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 180)))
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 430)))
        with patch("pygame.time.get_ticks", return_value=300):
            self.app.render()
        self.assertEqual(self.app.review_page, 1)
        self.app.choose("approved")
        self.assertEqual(self.worker.decisions[-1], (EMAIL_REQUEST["id"], "approved"))
        self.assertEqual(self.app.state, "submitting")

    def test_gmail_notification_swipe_down_renders_the_full_email(self):
        self.app.state = "request"
        self.app.request = GMAIL_NOTIFICATION
        self.app.reduce_motion = True
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 160)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 430)))

        self.assertEqual(self.app.review_page, 1)
        with patch.object(self.app, "_wrapped", wraps=self.app._wrapped) as wrapped:
            self.app.render()
        self.assertIn(GMAIL_NOTIFICATION["presentation"]["email"], [call.args[0] for call in wrapped.call_args_list])
        self.assertIn(520, [call.args[3] for call in wrapped.call_args_list if call.args[0] == GMAIL_NOTIFICATION["presentation"]["subject"]])

    def test_long_gmail_headers_and_subjects_stay_inside_the_screen(self):
        header = "Mohit Madan <mohitmadan128@gmail.com> · Mon, 20 Jul 2026 15:28:58 +0530"
        subject = "hi i was interested in your business can we have a meeting to discuss the complete proposal"

        self.assertTrue(all(self.app.review_label.size(line)[0] <= 560 for line in wrap(self.app.review_label, header, 560, 1)))
        subject_lines = wrap(self.app.review_title, subject, 520, 2)
        self.assertTrue(all(self.app.review_title.size(line)[0] <= 520 for line in subject_lines))
        self.assertGreater(len(subject_lines), 1)

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

    def test_button_chord_records_without_triggering_a_decision(self):
        now = [10.0]
        actions = []
        recordings = []
        chord = ButtonChord(actions.append, lambda: recordings.append("start"), lambda: recordings.append("stop"), clock=lambda: now[0])
        chord.press("approve")
        now[0] += 0.1
        chord.press("reject")
        chord.release("approve")
        chord.release("reject")
        self.assertEqual(actions, [])
        self.assertEqual(recordings, ["start", "stop"])

    def test_single_button_release_decides_after_chord_window(self):
        actions = []
        chord = ButtonChord(actions.append, lambda: None, lambda: None)
        chord.press("reject")
        chord.release("reject")
        self.assertEqual(actions, ["rejected"])

    def test_recorder_uses_required_pcm_format_and_duration(self):
        process = type("Process", (), {"poll": lambda self: None, "terminate": lambda self: None, "wait": lambda self, timeout: None})()
        with patch("podex_pod.audio.subprocess.Popen", return_value=process) as popen:
            recorder = Recorder(Path(self.temp.name))
            recorder.start()
            recorder.stop()
        arguments = popen.call_args.args[0]
        self.assertEqual(arguments[1:9], ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-d"])
        self.assertEqual(arguments[9], "30")

    def test_confirmed_transcript_uses_active_target_revision(self):
        self.app.codex = {"target": {"revision": 4}, "thread": {"status": "waiting"}}
        self.app.transcript = "Make the retry smaller"
        self.app.state = "transcript"
        self.app.choose("approved")
        self.assertEqual(self.worker.prompts, [("Make the retry smaller", 4, None)])
        self.assertEqual(self.app.state, "queued")

    def test_confirmed_voice_revision_replaces_the_exact_plan(self):
        plan = {**REQUEST, "source": "Codex", "codex_payload": {"plan": "Original plan"}}
        self.app.codex = {"target": {"revision": 5}, "thread": {"status": "waiting"}}
        self.app.request = plan
        self.app.state = "request"
        self.app.voice_revision_request = plan
        self.app.transcript = "Keep the API backwards compatible"
        self.app.state = "transcript"
        self.app.choose("approved")
        self.assertEqual(self.worker.prompts, [("Keep the API backwards compatible", 5, plan)])

    def test_mouse_and_touch_input_normalize_and_scroll(self):
        self.assertEqual(self.app.logical_point((320, 238)), (320, 238))
        self.assertIsNone(self.app.logical_point((700, 500)))
        self.app.scroll = 100
        self.app.handle_event(pygame.event.Event(pygame.FINGERMOTION, dy=0.1))
        self.assertEqual(self.app.scroll, 52)
        self.app.handle_event(pygame.event.Event(pygame.MOUSEWHEEL, y=-1))
        self.assertEqual(self.app.scroll, 88)

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

        layout = {"left": ["app:github"], "right": ["app:gmail"], "down": ["app:codex"]}
        self.worker.events.put({"event": "screen_layout", "screen_layout": layout, "screen_items": []})
        self.app.apply_worker_events()
        self.assertEqual(self.app.screen_layout, layout)

    def test_idle_screen_layout_renders_and_swipes_between_screens(self):
        self.app.state = "idle"
        self.assertEqual(self.app.screen, "home")
        self.assertEqual(self.app.render().get_size(), (640, 480))

        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(500, 240)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(200, 240)))
        self.assertEqual(self.app.screen, "left")
        self.app.handle_event(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_RIGHT))
        self.assertEqual(self.app.screen, "home")
        self.app.handle_event(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_RIGHT))
        self.assertEqual(self.app.screen, "right")
        self.app.handle_event(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_LEFT))
        self.assertEqual(self.app.screen, "home")

    def test_feed_swipe_up_opens_quick_settings_and_down_returns(self):
        self.app.state = "idle"
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 400)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 160)))

        self.assertTrue(self.app.quick_settings)
        self.assertEqual(self.app.render().get_size(), (640, 480))

        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 160)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 400)))
        self.assertFalse(self.app.quick_settings)

    def test_quick_settings_rows_change_and_persist(self):
        self.app.state = "idle"
        self.app.quick_settings = True
        for y in (118, 274, 326):
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, y)))
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, y)))
        for y in (170, 222):
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(360, y)))
            self.app.handle_event(pygame.event.Event(pygame.MOUSEMOTION, pos=(540, y), rel=(180, 0)))
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(540, y)))

        self.assertTrue(self.worker.offline)
        self.assertEqual((self.app.brightness, self.app.volume, self.app.reduce_motion, self.app.idle_animation_seconds), (75, 75, True, 60))
        self.assertEqual(self.storage.settings(), {"brightness": 75, "volume": 75, "reduce_motion": True, "idle_animation_seconds": 60})

    def test_hardware_volume_uses_alsa_and_missing_control_is_safe(self):
        self.app.simulator = False
        with patch("podex_pod.app.subprocess.run") as run:
            self.app._apply_volume()
        self.assertEqual(run.call_args.args[0], ["amixer", "sset", "Master", "50%"])
        with patch("podex_pod.app.subprocess.run", side_effect=FileNotFoundError):
            self.app._apply_volume()

    def test_new_notification_opens_its_feed_and_swipe_down_shows_details(self):
        self.app.quick_settings = True
        self.worker.events.put({"event": "request", "request": REQUEST, "queue_size": 1, "request_screen": "left"})
        self.app.apply_worker_events()

        self.assertEqual(self.app.screen, "left")
        self.assertEqual(self.app.notification_screen, "left")
        self.assertFalse(self.app.quick_settings)
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 160)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 400)))
        self.assertEqual(self.app.review_page, 1)
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 400)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 160)))
        self.assertEqual(self.app.review_page, 0)

    def test_idle_touchscreen_taps_navigate_and_decisions_return_home(self):
        self.app.state = "idle"
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(500, 240)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(500, 240)))
        self.assertEqual(self.app.screen, "home")

        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(100, 240)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(100, 240)))
        self.assertEqual(self.app.screen, "home")

        self.app.screen = "right"
        self.worker.events.put({"event": "decided", "outcome": "approved"})
        self.app.apply_worker_events()
        self.assertEqual(self.app.screen, "home")

    def test_every_feed_symbol_has_a_distinct_pod_render(self):
        renders = set()
        for feed_id in ("calendar", "notion", "gmail", "important", "github", "deployments", "slack", "n8n"):
            self.app.surface.fill(BACKGROUND)
            self.app._feed_icon(feed_id, 0, 0)
            renders.add(pygame.image.tobytes(self.app.surface.subsurface((0, 0, 20, 20)), "RGB"))

        self.assertEqual(len(renders), 8)

    def test_worker_emits_changed_screen_layout_from_the_poll_response(self):
        layout = {"left": ["app:github"], "right": ["app:gmail"], "down": ["app:codex"]}

        class LayoutClient:
            def current_request(self, _token):
                return {"request": None, "queue_size": 0, "codex": {}, "screen_layout": layout}

        self.storage.save_credentials("pod_token")
        worker = PodWorker(LayoutClient(), self.storage, poll_seconds=0.01)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1), {"event": "screen_layout", "screen_layout": layout, "screen_items": []})
        worker.close()
        worker.join(timeout=1)

    def test_worker_emits_idle_only_once_while_polling(self):
        class IdleClient:
            def current_request(self, _token):
                return {"request": None, "queue_size": 0, "codex": {}}

        self.storage.save_credentials("pod_token")
        worker = PodWorker(IdleClient(), self.storage, poll_seconds=0.01)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1)["event"], "idle")
        with self.assertRaises(queue.Empty):
            worker.events.get(timeout=0.05)
        worker.close()
        worker.join(timeout=1)

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

    def test_automatic_reconnect_reemits_the_cached_request(self):
        class FlakyRequestClient:
            def __init__(self):
                self.calls = 0

            def current_request(self, _token):
                self.calls += 1
                if self.calls == 2:
                    raise ApiError(0, "Offline")
                return {"request": REQUEST, "queue_size": 1}

        self.storage.save_credentials("pod_token")
        worker = PodWorker(FlakyRequestClient(), self.storage, poll_seconds=0.01)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1)["event"], "request")
        self.assertEqual(worker.events.get(timeout=1)["event"], "offline")
        self.assertEqual(worker.events.get(timeout=1)["event"], "request")
        worker.close()
        worker.join(timeout=1)

    def test_transient_decision_failure_retries_with_the_same_key(self):
        class FlakyDecisionClient:
            def __init__(self):
                self.keys = []

            def current_request(self, _token):
                return {"request": REQUEST, "queue_size": 1}

            def decide(self, _token, _request_id, _outcome, _payload_hash, idempotency_key):
                self.keys.append(idempotency_key)
                if len(self.keys) == 1:
                    raise ApiError(0, "Offline")

        self.storage.save_credentials("pod_token")
        client = FlakyDecisionClient()
        worker = PodWorker(client, self.storage, poll_seconds=0.01)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1)["event"], "request")
        worker.decide(REQUEST, "approved")
        self.assertEqual(worker.events.get(timeout=1)["event"], "offline")
        self.assertEqual(worker.events.get(timeout=1)["event"], "decided")
        self.assertEqual(len(client.keys), 2)
        self.assertEqual(client.keys[0], client.keys[1])
        worker.close()
        worker.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
