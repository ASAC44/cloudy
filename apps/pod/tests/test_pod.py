import os
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
os.environ.setdefault("GPIOZERO_PIN_FACTORY", "mock")

import io
import queue
import stat
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import pygame
from gpiozero import Button, Device
from gpiozero.pins.mock import MockFactory

from cloudy_pod.app import BACKGROUND, INK, PodApp, idle_pose, mascot_action_pose, wrap, yawn_openness
from cloudy_pod.audio import ButtonChord, Recorder
from cloudy_pod.client import ApiClient, ApiError
from cloudy_pod.hardware import ABS_PRESSURE, ABS_X, ABS_Y, EV_ABS, EV_SYN, INPUT_EVENT, SYN_REPORT, FramebufferOutput, TouchInput
from cloudy_pod.storage import Storage
from cloudy_pod.worker import PodWorker


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
        "context": "cloudy/api · feature/payment-retries → main",
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

DEPLOYMENT_REQUEST = {
    **REQUEST,
    "title": "Rollback checkout-web canary",
    "presentation": {
        "kind": "notification_v1",
        "sender": "Vercel",
        "destination": "Production · cloudy-web",
        "excerpt": "Canary errors reached 4.8%.",
        "recommended_action": "Rollback traffic to the last healthy deployment.",
    },
}

EMAIL_REQUEST = {
    **REQUEST,
    "title": "Tomorrow's project review",
    "source": "Gmail",
    "action_payload": {"kind": "ping_rule_action", "event_id": "event-2"},
    "presentation": {
        "kind": "email_reply_v1",
        "sender": "aniketyadav982@gmail.com",
        "time": "09:42",
        "subject": "Tomorrow's project review",
        "summary": "Aniket wants to move tomorrow's project review to 3:30 PM and needs a new calendar invite.",
        "email": "Hi Vansh,\n\nCould we move tomorrow's project review to 3:30 PM?\n\nThanks,\nAniket",
        "response": "Absolutely, 3:30 PM works for me. I've moved the meeting and sent an updated invite.",
    },
}

GMAIL_NOTIFICATION = {
    **REQUEST,
    "title": "Tomorrow's project review",
    "source": "Gmail",
    "presentation": {
        "kind": "gmail_notification_v1",
        "sender": "aniketyadav982@gmail.com",
        "time": "09:42",
        "subject": "Tomorrow's project review",
        "summary": "A new incoming Gmail message matched this Ping.",
        "email": "Hi Vansh,\n\nCould we move tomorrow's project review to 3:30 PM?\n\nThanks,\nAniket",
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
        self.storage.save_settings({"brightness": 50, "volume": 75, "reduce_motion": True})
        restarted = PodApp(self.worker, Storage(Path(self.temp.name)), simulator=True)

        self.assertEqual((restarted.brightness, restarted.volume, restarted.reduce_motion), (50, 75, True))

    def test_long_text_wraps_within_width(self):
        lines = wrap(self.app.font, "one two three four five six seven", 80)
        self.assertGreater(len(lines), 1)
        self.assertTrue(all(self.app.font.size(line)[0] <= 80 for line in lines))

    def test_wrapped_text_applies_left_margin_once(self):
        with patch.object(self.app, "_blit") as blit:
            self.app._wrapped("GitHub", 30, 70, 580, self.app.small)

        self.assertEqual(blit.call_args.args[1], 10)

    def test_body_typography_is_shared_across_pod_screens(self):
        self.assertIs(self.app.review_label, self.app.small)
        self.assertGreaterEqual(self.app.review_body.get_linesize() - self.app.font.get_linesize(), 5)
        self.assertGreaterEqual(self.app.notification_body.get_linesize() - self.app.font.get_linesize(), 10)
        self.assertGreaterEqual(self.app.review_detail.get_linesize() - self.app.font.get_linesize(), 10)

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

    def test_input_marks_static_hardware_frame_for_redraw(self):
        self.app.needs_render = False

        self.app.handle_event(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_DOWN))

        self.assertTrue(self.app.needs_render)

    def test_framebuffer_output_scales_to_rgb565(self):
        path = Path(self.temp.name) / "fb0"
        path.write_bytes(b"\0" * 4)
        source = pygame.Surface((1, 1))
        source.fill("red")
        output = FramebufferOutput(path, (2, 1))
        output.device = Mock(wraps=output.device)

        output.present(source)
        output.present(source)
        output.close()

        self.assertEqual(path.read_bytes(), b"\x00\xf8\x00\xf8")
        self.assertEqual(output.device.write.call_count, 1)

    def test_framebuffer_auto_detects_ili9341(self):
        framebuffer = Path("/sys/class/graphics/fb1")
        with (
            patch.dict(os.environ, {"CLOUDY_FRAMEBUFFER": "auto"}),
            patch.object(Path, "glob", return_value=[framebuffer]),
            patch.object(Path, "read_text", return_value="fb_ili9341"),
            patch.object(FramebufferOutput, "__init__", return_value=None) as initialize,
        ):
            FramebufferOutput.from_env()

        initialize.assert_called_once_with(Path("/dev/fb1"))

    def test_hardware_renders_at_native_framebuffer_resolution(self):
        framebuffer = Mock(size=(320, 240))
        with patch("cloudy_pod.app.FramebufferOutput.from_env", return_value=framebuffer):
            app = PodApp(self.worker, self.storage, simulator=False)

        self.assertEqual(app.render().get_size(), (320, 240))

    def test_touch_input_emits_calibrated_press_motion_and_release(self):
        touch = object.__new__(TouchInput)
        touch.device = io.BytesIO(b"".join((
            INPUT_EVENT.pack(0, 0, EV_ABS, ABS_X, 4095),
            INPUT_EVENT.pack(0, 0, EV_ABS, ABS_Y, 0),
            INPUT_EVENT.pack(0, 0, EV_ABS, ABS_PRESSURE, 100),
            INPUT_EVENT.pack(0, 0, EV_SYN, SYN_REPORT, 0),
            INPUT_EVENT.pack(0, 0, EV_ABS, ABS_X, 2048),
            INPUT_EVENT.pack(0, 0, EV_ABS, ABS_Y, 2048),
            INPUT_EVENT.pack(0, 0, EV_SYN, SYN_REPORT, 0),
            INPUT_EVENT.pack(0, 0, EV_ABS, ABS_PRESSURE, 0),
            INPUT_EVENT.pack(0, 0, EV_SYN, SYN_REPORT, 0),
        )))
        touch.x_range = (0, 4095)
        touch.y_range = (0, 4095)
        touch.x = 0
        touch.y = 0
        touch.pressed = False
        touch.was_pressed = False
        touch.moved = False
        touch.last_point = (0, 0)
        touch.invert_x = True
        touch.invert_y = False
        touch.swap_xy = True

        events = touch.poll()

        self.assertEqual([event[0] for event in events], ["down", "motion", "up"])
        self.assertEqual(events[0][1:3], (0, 0))
        self.assertAlmostEqual(events[1][1], 2048 / 4095)
        self.assertAlmostEqual(events[1][2], 1 - 2048 / 4095)

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

    def test_screen_two_is_default_and_mascot_shows_when_queue_is_idle(self):
        with patch.object(self.app, "_render_idle", wraps=self.app._render_idle) as render_idle:
            self.app.state = "idle"
            self.app.screen = "home"
            self.app.render()
            self.app.state = "request"
            self.app.request = REQUEST
            self.app.render()

        render_idle.assert_called_once()

    def test_screen_without_an_active_ping_shows_mascot_immediately(self):
        self.app.state = "idle"
        self.app.screen_layout = {"left": ["app:github", "app:gmail"], "right": [], "down": []}
        self.app.screen = "left"

        with patch.object(self.app, "_render_idle", wraps=self.app._render_idle) as render_idle:
            self.app.render()

        render_idle.assert_called_once()

    def test_approve_while_idle_triggers_two_second_yawn(self):
        self.app.state = "idle"
        with patch("cloudy_pod.app.time.monotonic", return_value=100):
            self.app.choose("approved")

        self.assertEqual(self.worker.decisions, [])
        self.assertEqual(self.app.last_interaction_at, 100)
        self.assertEqual(self.app.mascot_action, "yawn")
        self.assertEqual(yawn_openness(0), 0)
        self.assertEqual(yawn_openness(1), 1)
        self.assertEqual(yawn_openness(2), 0)

    def test_dashboard_mascot_actions_have_distinct_animation_poses(self):
        blink = mascot_action_pose("blink", 0.5)
        yawn = mascot_action_pose("yawn", 1)
        sleep = mascot_action_pose("sleep", 0.5)
        jump = mascot_action_pose("jump", 0.5)

        self.assertTrue(blink[2])
        self.assertEqual(yawn[3], 1)
        self.assertTrue(sleep[2])
        self.assertLess(jump[0], 0)

    def test_decision_results_animate_and_have_distinct_outcomes(self):
        self.app.result_started = 100
        self.app.state = "approved"
        with patch("cloudy_pod.app.time.monotonic", return_value=100.1):
            early = pygame.image.tobytes(self.app.render(), "RGB")
        with patch("cloudy_pod.app.time.monotonic", return_value=100.8):
            approved = pygame.image.tobytes(self.app.render(), "RGB")
        self.app.state = "rejected"
        with patch("cloudy_pod.app.time.monotonic", return_value=100.8):
            rejected = pygame.image.tobytes(self.app.render(), "RGB")

        self.assertNotEqual(early, approved)
        self.assertNotEqual(approved, rejected)

    def test_mascot_action_temporarily_overlays_without_clearing_a_request(self):
        self.app.state = "request"
        self.app.request = REQUEST
        with patch("cloudy_pod.app.time.monotonic", return_value=100):
            self.app.play_mascot_action("jump")
        with patch("cloudy_pod.app.time.monotonic", return_value=100.5):
            self.app.render()
        with patch("cloudy_pod.app.time.monotonic", return_value=102.5):
            self.app.render()

        self.assertEqual(self.app.state, "request")
        self.assertIs(self.app.request, REQUEST)
        self.assertIsNone(self.app.mascot_action)

    def test_github_demo_is_read_only(self):
        with patch.dict(os.environ, {"CLOUDY_DEMO": "github-pr"}):
            demo = PodApp(self.worker, self.storage, simulator=True)

        demo.choose("approved")
        self.assertEqual(demo.state, "request")
        self.assertEqual(demo.request["source"], "GitHub · PR merge")
        self.assertEqual(self.worker.decisions, [])
        with patch("pygame.time.get_ticks", return_value=0):
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 430)))
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 180)))
        with patch("pygame.time.get_ticks", return_value=300):
            demo.render()
        self.assertEqual(demo.review_page, 1)
        self.assertGreater(demo.detail_scroll_limit, 0)
        demo.handle_event(pygame.event.Event(pygame.MOUSEWHEEL, y=-1))
        self.assertEqual(demo.detail_scroll, 40)
        demo.detail_scroll = 0
        with patch("pygame.time.get_ticks", return_value=0):
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 180)))
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 400)))
        with patch("pygame.time.get_ticks", return_value=300):
            demo.render()
        self.assertEqual(demo.review_page, 0)

    def test_production_github_presentation_renders_swipes_and_decides(self):
        self.app.state = "request"
        self.app.request = GITHUB_REQUEST
        self.assertEqual(self.app.render().get_size(), (640, 480))
        with patch("pygame.time.get_ticks", return_value=0):
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 430)))
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 180)))
        with patch("pygame.time.get_ticks", return_value=300):
            self.app.render()
        self.assertEqual(self.app.review_page, 1)
        self.app.choose("approved")
        self.assertEqual(self.worker.decisions[-1], (GITHUB_REQUEST["id"], "approved"))
        self.assertEqual(self.app.state, "submitting")

    def test_deployment_ping_labels_its_recommended_action(self):
        self.app.state = "request"
        self.app.request = DEPLOYMENT_REQUEST
        with patch.object(self.app, "_text", wraps=self.app._text) as draw_text:
            self.app.render()
        labels = [call.args[0] for call in draw_text.call_args_list if call.args]
        self.assertIn("RECOMMENDED ACTION", labels)
        self.assertNotIn("WARNINGS", labels)
        self.assertFalse(any(str(label).startswith("PING 1 OF") for label in labels))

    def test_email_chat_demo_uses_local_approve_and_reject_flow(self):
        with patch.dict(os.environ, {"CLOUDY_DEMO": "email-chat"}):
            demo = PodApp(self.worker, self.storage, simulator=True)

        self.assertEqual(demo.state, "email_chat")
        self.assertEqual(demo.render().get_size(), (640, 480))
        with patch("pygame.time.get_ticks", return_value=0):
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 430)))
            demo.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 180)))
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
        with patch.object(self.app, "_wrapped", wraps=self.app._wrapped) as wrapped:
            self.assertEqual(self.app.render().get_size(), (640, 480))
        header_call = next(call for call in wrapped.call_args_list if "aniketyadav982@gmail.com" in call.args[0])
        self.assertIs(header_call.args[4], self.app.notification_label)
        with patch("pygame.time.get_ticks", return_value=0):
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 430)))
            self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 180)))
        with patch("pygame.time.get_ticks", return_value=300):
            self.app.render()
        self.assertEqual(self.app.review_page, 1)
        self.app.choose("approved")
        self.assertEqual(self.worker.decisions[-1], (EMAIL_REQUEST["id"], "approved"))
        self.assertEqual(self.app.state, "submitting")

    def test_gmail_notification_swipe_up_renders_the_full_email(self):
        self.app.state = "request"
        self.app.request = GMAIL_NOTIFICATION
        self.app.reduce_motion = True
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 430)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 160)))

        self.assertEqual(self.app.review_page, 1)
        with patch.object(self.app, "_wrapped", wraps=self.app._wrapped) as wrapped:
            self.app.render()
        self.assertIn(GMAIL_NOTIFICATION["presentation"]["email"], [call.args[0] for call in wrapped.call_args_list])
        self.assertIn(520, [call.args[3] for call in wrapped.call_args_list if call.args[0] == GMAIL_NOTIFICATION["presentation"]["subject"]])

    def test_telegram_and_mcp_details_render_message_and_source_event(self):
        self.app.state = "request"
        self.app.request = {**REQUEST, "presentation": {"sender": "@ava", "excerpt": "Need approval", "source_detail": '{"chat_type":"group"}'}}
        self.app.review_page = 1

        with patch.object(self.app, "_wrapped", wraps=self.app._wrapped) as wrapped:
            self.app.render()

        rendered = [call.args[0] for call in wrapped.call_args_list]
        self.assertIn("Need approval", rendered)
        self.assertIn('{"chat_type":"group"}', rendered)

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

    def test_touch_only_hardware_can_disable_gpio_buttons(self):
        self.app.simulator = False
        with patch.dict(os.environ, {"CLOUDY_BUTTONS": "0"}):
            self.app.start_gpio()
        self.assertEqual(self.app.buttons, [])

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
        with patch("cloudy_pod.audio.subprocess.Popen", return_value=process) as popen:
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

    def test_sse_parser_ignores_heartbeats_and_handles_multiple_events(self):
        response = io.BytesIO(
            b": keepalive\n\nevent: sync\ndata: {}\n\n"
            b"event: invalidate\ndata: {\"scope\":\"request\"}\n\n"
            b"event: revoked\ndata: {}\n\n"
        )
        with patch("cloudy_pod.client.urlopen", return_value=response):
            self.assertEqual(list(ApiClient("https://api.example.com").pod_events("token")), ["sync", "invalidate", "revoked"])

    def test_realtime_sync_wakes_snapshot_without_continuous_polling(self):
        invalidate = threading.Event()

        class RealtimeClient:
            def __init__(self):
                self.calls = 0

            def current_request(self, _token):
                self.calls += 1
                return {"request": None, "queue_size": 0, "codex": {}}

            def pod_events(self, _token):
                yield "sync"
                invalidate.wait(1)
                yield "invalidate"

        self.storage.save_credentials("pod_token")
        client = RealtimeClient()
        worker = PodWorker(client, self.storage, poll_seconds=0.01, safety_poll_seconds=1)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1)["event"], "idle")
        time.sleep(0.05)
        calls_before = client.calls
        self.assertLessEqual(calls_before, 2)
        invalidate.set()
        deadline = time.monotonic() + 1
        while client.calls <= calls_before and time.monotonic() < deadline:
            time.sleep(0.01)
        worker.close()
        worker.join(timeout=1)
        self.assertGreater(client.calls, calls_before)

    def test_realtime_refresh_clears_a_resolved_cached_request(self):
        class ResolvedClient:
            def current_request(self, _token):
                return {"request": None, "queue_size": 0, "codex": {}}

        self.storage.save_credentials("pod_token")
        self.storage.save_request(REQUEST)
        worker = PodWorker(ResolvedClient(), self.storage, poll_seconds=0.01)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1)["event"], "idle")
        worker.close()
        worker.join(timeout=1)

        self.assertIsNone(self.storage.request())

    def test_realtime_failure_uses_degraded_polling(self):
        class DegradedClient:
            def __init__(self):
                self.calls = 0

            def current_request(self, _token):
                self.calls += 1
                return {"request": None, "queue_size": 0, "codex": {}}

            def pod_events(self, _token):
                raise ApiError(503, "Realtime unavailable")
                yield

        self.storage.save_credentials("pod_token")
        client = DegradedClient()
        worker = PodWorker(client, self.storage, poll_seconds=0.01, safety_poll_seconds=1)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1)["event"], "idle")
        time.sleep(0.06)
        worker.close()
        worker.join(timeout=1)
        self.assertGreaterEqual(client.calls, 3)

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
        self.worker.events.put({"event": "screen_layout", "screen_layout": layout})
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
        self.assertEqual((self.app.brightness, self.app.volume, self.app.reduce_motion), (75, 75, True))
        self.assertEqual(self.storage.settings(), {"brightness": 75, "volume": 75, "reduce_motion": True})

    def test_hardware_volume_uses_alsa_and_missing_control_is_safe(self):
        self.app.simulator = False
        with patch("cloudy_pod.app.subprocess.run") as run:
            self.app._apply_volume()
        self.assertEqual(run.call_args.args[0], ["amixer", "sset", "Master", "50%"])
        with patch("cloudy_pod.app.subprocess.run", side_effect=FileNotFoundError):
            self.app._apply_volume()

    def test_new_notification_opens_its_feed_and_swipe_up_shows_details(self):
        self.app.quick_settings = True
        self.worker.events.put({"event": "request", "request": REQUEST, "queue_size": 1, "request_screen": "left"})
        self.app.apply_worker_events()

        self.assertEqual(self.app.screen, "left")
        self.assertEqual(self.app.notification_screen, "left")
        self.assertFalse(self.app.quick_settings)
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 400)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 160)))
        self.assertEqual(self.app.review_page, 1)
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=(320, 160)))
        self.app.handle_event(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=(320, 400)))
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

    def test_next_request_waits_for_dashboard_decision_animation(self):
        self.worker.events.put({"event": "decided", "outcome": "approved"})
        self.worker.events.put({"event": "request", "request": REQUEST, "queue_size": 1, "request_screen": "down"})
        self.app.apply_worker_events()

        self.assertEqual(self.app.state, "approved")
        self.assertIsNone(self.app.request)
        self.assertIsNotNone(self.app.pending_request_event)

        self.app._complete_decision_result()
        self.app.apply_worker_events()
        self.assertEqual(self.app.state, "request")
        self.assertEqual(self.app.request, REQUEST)

    def test_codex_mock_renders_a_plan_and_accepts_a_local_voice_revision(self):
        codex_request = {
            **REQUEST,
            "action_payload": {"kind": "test_ping", "mock_type": "codex", "screen": "down"},
            "presentation": {
                "kind": "codex_plan_v1",
                "workspace": "cloudy · /repos/podex",
                "title": "Add role-based access to workspaces",
                "summary": "The plan adds admin, editor, and viewer roles to workspace_members. It backfills current memberships in one transaction, updates row-level security and API permission checks, and includes a reversible rollback with tests for concurrent invitations and stale updates.",
                "steps": ["Add the role column.", "Backfill memberships.", "Update RLS policies.", "Test concurrent changes."],
            },
            "codex_payload": {"plan": "1. Add the role column.\n2. Backfill memberships.\n3. Update RLS policies.\n4. Test concurrent changes."},
        }
        self.app.state = "request"
        self.app.request = codex_request
        with patch.object(self.app, "_wrapped", wraps=self.app._wrapped) as wrapped, patch.object(self.app, "_text", wraps=self.app._text) as draw_text:
            self.assertNotEqual(pygame.image.tobytes(self.app.render(), "RGB"), bytes(640 * 480 * 3))
        rendered_paragraphs = [call.args[0] for call in wrapped.call_args_list]
        self.assertIn(codex_request["presentation"]["summary"], rendered_paragraphs)
        self.assertEqual(len(wrap(self.app.review_body, codex_request["presentation"]["summary"], 580)), 6)
        self.assertNotIn(codex_request["presentation"]["steps"][0], rendered_paragraphs)
        self.assertFalse(any(call.args and call.args[0] == "PROPOSED PLAN" for call in draw_text.call_args_list))

        self.app.screen = self.app.notification_screen = "home"
        self.app.navigate_screen("up")
        self.assertEqual(self.app.review_page, 1)
        with patch.object(self.app, "_text", wraps=self.app._text) as draw_text:
            self.app.render()
        self.assertTrue(any(call.args and call.args[0] == "FULL PLAN" for call in draw_text.call_args_list))

        self.app.voice_revision_request = codex_request
        self.app.transcript = "Keep the migration reversible and show the rollback test."
        self.app.state = "transcript"
        self.app.choose("approved")

        self.assertEqual(self.app.state, "request")
        self.assertEqual(self.app.review_page, 1)
        self.assertEqual(self.app.request["codex_payload"]["revision_note"], "Keep the migration reversible and show the rollback test.")
        self.assertEqual(self.worker.prompts, [])

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
        self.assertEqual(worker.events.get(timeout=1), {"event": "screen_layout", "screen_layout": layout})
        worker.close()
        worker.join(timeout=1)

    def test_worker_emits_dashboard_screen_navigation(self):
        class NavigationClient:
            def current_request(self, _token):
                return {"request": None, "queue_size": 0, "codex": {}, "screen_navigation": ["up", "scroll_down", "scroll_up"]}

        self.storage.save_credentials("pod_token")
        worker = PodWorker(NavigationClient(), self.storage, poll_seconds=0.01)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1), {"event": "screen_navigation", "direction": "up"})
        self.assertEqual(worker.events.get(timeout=1), {"event": "screen_navigation", "direction": "scroll_down"})
        self.assertEqual(worker.events.get(timeout=1), {"event": "screen_navigation", "direction": "scroll_up"})
        worker.close()
        worker.join(timeout=1)

    def test_realtime_navigation_does_not_reset_the_current_notification(self):
        invalidate = threading.Event()

        class NavigationClient:
            def __init__(self):
                self.calls = 0

            def current_request(self, _token):
                self.calls += 1
                return {
                    "request": REQUEST,
                    "queue_size": 1,
                    "codex": {},
                    "screen_navigation": "up" if self.calls > 1 else None,
                }

            def pod_events(self, _token):
                invalidate.wait(1)
                yield "invalidate"

        self.storage.save_credentials("pod_token")
        worker = PodWorker(NavigationClient(), self.storage, poll_seconds=0.01, safety_poll_seconds=10)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1)["event"], "request")
        invalidate.set()
        self.assertEqual(worker.events.get(timeout=1), {"event": "screen_navigation", "direction": "up"})
        self.assertTrue(worker.events.empty())
        worker.close()
        worker.join(timeout=1)

    def test_dashboard_screen_navigation_moves_between_feed_screens(self):
        self.app.state = "idle"
        self.app.navigate_screen("left")
        self.assertEqual(self.app.screen, "left")
        self.app.navigate_screen("right")
        self.assertEqual(self.app.screen, "home")
        self.app.navigate_screen("right")
        self.assertEqual(self.app.screen, "right")
        self.app.navigate_screen("up")
        self.assertTrue(self.app.quick_settings)
        self.app.navigate_screen("down")
        self.assertFalse(self.app.quick_settings)

    def test_dashboard_navigation_opens_and_closes_notification_details(self):
        self.app.state = "request"
        self.app.request = REQUEST
        self.app.screen = self.app.notification_screen = "home"

        self.app.navigate_screen("up")
        self.assertEqual(self.app.review_page, 1)
        self.assertFalse(self.app.quick_settings)
        self.app.detail_scroll_limit = 1000
        self.app.navigate_screen("up")
        self.assertEqual(self.app.detail_scroll, 0)
        self.app.navigate_screen("scroll_down")
        self.assertEqual(self.app.detail_scroll, 240)
        self.app.navigate_screen("scroll_up")
        self.assertEqual(self.app.detail_scroll, 0)
        self.app.navigate_screen("down")
        self.assertEqual(self.app.review_page, 0)
        self.app.navigate_screen("scroll_down")
        self.assertEqual(self.app.detail_scroll, 0)

    def test_dashboard_can_scroll_gmail_while_details_are_opening(self):
        self.app.state = "request"
        self.app.request = EMAIL_REQUEST
        self.app.screen = self.app.notification_screen = "home"
        self.app.detail_scroll_limit = 1000

        with patch("pygame.time.get_ticks", return_value=0):
            self.app.navigate_screen("up")
            self.app.navigate_screen("scroll_down")

        self.assertEqual(self.app.detail_scroll, 240)

    def test_worker_emits_dashboard_mascot_action(self):
        class AnimationClient:
            def current_request(self, _token):
                return {"request": None, "queue_size": 0, "codex": {}, "mascot_action": "jump"}

        self.storage.save_credentials("pod_token")
        worker = PodWorker(AnimationClient(), self.storage, poll_seconds=0.01)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1), {"event": "mascot_action", "action": "jump"})
        worker.close()
        worker.join(timeout=1)

    def test_worker_emits_dashboard_decision_animation_without_idle_reset(self):
        class DecisionClient:
            def current_request(self, _token):
                return {"request": None, "queue_size": 0, "codex": {}, "decision_animation": "rejected"}

        self.storage.save_credentials("pod_token")
        worker = PodWorker(DecisionClient(), self.storage, poll_seconds=1)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1), {"event": "decided", "outcome": "rejected"})
        self.assertTrue(worker.events.empty())
        worker.close()
        worker.join(timeout=1)

    def test_worker_reemits_an_existing_request_when_its_screen_changes(self):
        responses = iter([
            {"request": REQUEST, "queue_size": 1, "codex": {}, "request_screen": "down"},
            {"request": REQUEST, "queue_size": 1, "codex": {}, "request_screen": "left"},
        ])

        class RequestClient:
            def current_request(self, _token):
                return next(responses)

        self.storage.save_credentials("pod_token")
        worker = PodWorker(RequestClient(), self.storage, poll_seconds=0.01)
        worker.start()
        first = worker.events.get(timeout=1)
        self.assertEqual(first["event"], "request")
        self.assertEqual(first["request_screen"], "down")
        second = worker.events.get(timeout=1)
        self.assertEqual(second["event"], "request")
        self.assertEqual(second["request_screen"], "left")
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

    def test_worker_reemits_a_request_when_its_payload_hash_changes(self):
        class RevisedRequestClient:
            def __init__(self):
                self.calls = 0

            def current_request(self, _token):
                self.calls += 1
                request = {**REQUEST, "payload_hash": ("a" if self.calls == 1 else "b") * 64}
                return {"request": request, "queue_size": 1}

        self.storage.save_credentials("pod_token")
        worker = PodWorker(RevisedRequestClient(), self.storage, poll_seconds=0.01)
        worker.start()
        first = worker.events.get(timeout=1)
        second = worker.events.get(timeout=1)
        self.assertEqual(first["request"]["payload_hash"], "a" * 64)
        self.assertEqual(second["request"]["payload_hash"], "b" * 64)
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

    def test_resolved_decision_clears_the_stale_request(self):
        class ResolvedDecisionClient:
            def current_request(self, _token):
                return {"request": REQUEST, "queue_size": 1}

            def decide(self, *_args):
                raise ApiError(409, "request already resolved")

        self.storage.save_credentials("pod_token")
        self.storage.save_request(REQUEST)
        worker = PodWorker(ResolvedDecisionClient(), self.storage, poll_seconds=0.01)
        worker.start()
        self.assertEqual(worker.events.get(timeout=1)["event"], "request")
        worker.decide(REQUEST, "approved")
        self.assertEqual(worker.events.get(timeout=1)["event"], "idle")
        self.assertIsNone(self.storage.request())
        worker.close()
        worker.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
