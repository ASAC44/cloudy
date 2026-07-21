import math
import os
import queue
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if os.getenv("CLOUDY_FRAMEBUFFER"):
    os.environ.setdefault("SDL_VIDEODRIVER", "offscreen")

import pygame

from .client import ApiClient
from .audio import ButtonChord, Recorder
from .hardware import FramebufferOutput, TouchInput
from .storage import Storage
from .worker import PodWorker

LOGICAL_SIZE = (640, 480)
SIMULATOR_SIZE = LOGICAL_SIZE
BACKGROUND = pygame.Color("#000000")
INK = pygame.Color("#ffffff")
MUTED = pygame.Color("#b8a998")
DIVIDER = pygame.Color("#3a2e25")
CLAY = pygame.Color("#ee8d70")
GREEN = pygame.Color("#71c49b")
AMBER = pygame.Color("#d9a45b")
MASCOT_TOP = pygame.Color("#a991ff")
MASCOT_BOTTOM = pygame.Color("#4f6dff")
FONT_DIR = Path(__file__).with_name("fonts")
FONT_PATH = FONT_DIR / "Geist-Medium.ttf"
MONO_FONT_PATH = FONT_DIR / "GeistMono-Regular.ttf"
POD_TYPE_SCALE = {
    "label": 16,
    "body": 19,
    "review_body": 25,
    "title": 28,
    "notification_label": 22,
    "notification_body": 29,
    "notification_title": 34,
    "detail_label": 22,
    "detail_body": 29,
    "idle": 34,
    "display": 40,
    "code": 54,
}
GITHUB_DEMO_REQUEST = {
    "id": "demo-github-pr",
    "title": "#482 · Add payment retries",
    "source": "GitHub · PR merge",
    "context": "cloudy/api · feature/payment-retries → main",
    "summary": (
        "Replaces 30-second retries with backoff at 1, 5, and 30 minutes. "
        "Successful retries restore the order immediately. After a fourth failure, "
        "automated attempts stop, the order remains unpaid, and support receives a "
        "manual-review notification. Checkout and completed payments are unchanged."
    ),
    "glance_details": (
        ("SAFETY", "No migration · no permissions · no downtime"),
        ("ROLLBACK", "Disable payment-retry-v2 flag"),
        ("OWNER", "Payments · first-hour monitoring"),
        ("MONITOR", "Retry success · duplicate charges · support volume"),
    ),
    "details": (
        (
            "DECISION REQUESTED",
            "Allow PR #482 to squash-merge into main after the required checks and reviews have passed.",
        ),
        (
            "CURRENT BEHAVIOR",
            "A failed customer payment retries every 30 seconds. Repeated failures continue until the worker limit is reached.",
        ),
        (
            "PROPOSED CHANGE",
            "Use backoff at 1, 5, and 30 minutes. A fourth failure moves the payment to manual review.",
        ),
        (
            "END-TO-END FLOW",
            "A failed charge enters the retry worker. Success restores the order; exhausted retries notify support and leave it unpaid.",
        ),
        (
            "SYSTEMS AND DATA",
            "Touches the payment retry worker, order payment status, support notification event, and retry-attempt timestamps.",
        ),
        (
            "CUSTOMER IMPACT",
            "Customers see fewer repeated attempts. Completed payments and existing orders are unchanged.",
        ),
        (
            "FAILURE MODES",
            "Provider outages delay retries. Exhausted retries stop automatically, keep the order unpaid, and route it to support.",
        ),
        (
            "REVIEW EVIDENCE",
            "Twelve automated checks passed, two reviewers approved, branch protection passed, and no merge conflicts remain.",
        ),
        (
            "SAFETY AND ROLLBACK",
            "Checks and reviews passed. Roll back with the payment-retry-v2 flag; no data migration is involved.",
        ),
        (
            "AFTER MERGE",
            "Watch retry success rate, duplicate-charge alerts, exhausted retries, and support volume during the first hour.",
        ),
    ),
    "risk": "medium",
    "facts": (
        ("AUTHOR", "vimzh"),
        ("FILES", "14"),
        ("DIFF", "+184/-39"),
        ("CHECKS", "12/12"),
        ("REVIEWS", "2/2"),
        ("AREA", "Payments"),
        ("DEPLOY", "Staging"),
        ("EXPIRES", "8m"),
    ),
    "expires_at": "2099-01-01T00:00:00+00:00",
}
EMAIL_CHAT_DEMO = {
    "sender": "aniketyadav982@gmail.com",
    "time": "09:42",
    "subject": "Tomorrow's project review",
    "summary": "Aniket wants to move tomorrow's project review to 3:30 PM and needs a new calendar invite.",
    "email": (
        "Hi Vansh,\n\nCould we move tomorrow's project review to the afternoon? "
        "3:30 PM works for me. If that works for you, please send an updated calendar invite.\n\nThanks,\nAniket"
    ),
    "response": (
        "Absolutely, 3:30 PM works for me. I've moved the project review and sent an updated invite. "
        "See you tomorrow."
    ),
}

DEFAULT_SCREEN_LAYOUT = {
    "left": ["app:github"],
    "right": ["app:gmail"],
    "down": ["app:codex"],
}
MASCOT_ACTION_DURATIONS = {"blink": 2.0, "yawn": 2.0, "sleep": 5.0, "jump": 2.4}
DECISION_ANIMATION_SECONDS = 3.4


def idle_pose(elapsed_seconds: float) -> tuple[float, float, bool]:
    """Return the idle mascot's vertical offset, size, and blink state."""
    float_offset = 7 * math.sin(elapsed_seconds * math.tau / 5)
    size = 248 + 8 * math.sin(elapsed_seconds * math.tau / 3.6)
    blink_phase = elapsed_seconds % 3.2
    return float_offset, size, 2.8 <= blink_phase < 3.0


def yawn_openness(elapsed_seconds: float) -> float:
    return math.sin(math.pi * elapsed_seconds / 2) if 0 <= elapsed_seconds < 2 else 0.0


def mascot_action_pose(action: str, elapsed_seconds: float) -> tuple[float, float, bool, float]:
    if action == "blink":
        return 0, 248, 0.3 <= elapsed_seconds < 1.5, 0
    if action == "yawn":
        return 0, 248, False, yawn_openness(elapsed_seconds)
    if action == "sleep":
        return 3 * math.sin(elapsed_seconds * math.tau / 2), 248, True, 0
    progress = min(1, elapsed_seconds / MASCOT_ACTION_DURATIONS["jump"])
    arc = math.sin(math.pi * progress)
    return -70 * arc, 248 - 10 * arc, False, 0


def high_res_mascot(blinking: bool) -> pygame.Surface:
    """Render the mascot large so it stays smooth when animated on the Pod."""
    scale = 16
    size = 50 * scale
    mask = pygame.Surface((size, size), pygame.SRCALPHA)
    pygame.draw.rect(mask, pygame.Color("white"), (10 * scale, 12 * scale, 29 * scale, 27 * scale))
    for center, radius in (((15, 13), 8), ((24, 10), 10), ((34, 14), 9), ((40, 23), 8), ((38, 33), 9), ((29, 39), 10), ((18, 38), 9), ((10, 30), 9), ((8, 20), 8)):
        pygame.draw.circle(
            mask,
            pygame.Color("white"),
            (center[0] * scale, center[1] * scale),
            radius * scale,
        )

    mascot = pygame.Surface((size, size), pygame.SRCALPHA)
    for y in range(size):
        color = MASCOT_TOP.lerp(MASCOT_BOTTOM, y / (size - 1))
        pygame.draw.line(mascot, color, (0, y), (size, y))
    mascot.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MULT)

    eye_height = (2 if blinking else 11) * scale
    eye_y = (25 if blinking else 20) * scale
    for eye_x in (17, 29):
        pygame.draw.rect(
            mascot,
            BACKGROUND,
            (eye_x * scale, eye_y, 5 * scale, eye_height),
            border_radius=2 * scale,
        )
    return mascot


def wrap(font: pygame.font.Font, value: str, width: int, max_lines: int | None = None) -> list[str]:
    lines: list[str] = []
    for paragraph in value.splitlines() or [""]:
        current = ""
        for word in paragraph.split():
            candidate = f"{current} {word}".strip()
            if current and font.size(candidate)[0] > width:
                lines.append(current)
                current = word
            else:
                current = candidate
        lines.append(current)
    if max_lines is None or len(lines) <= max_lines:
        return lines
    last = lines[max_lines - 1].rstrip()
    while last and font.size(f"{last}…")[0] > width:
        last = last[:-1].rstrip()
    return [*lines[: max_lines - 1], f"{last}…"]


class PodApp:
    def __init__(self, worker: PodWorker, storage: Storage, simulator: bool = True):
        pygame.init()
        self.worker = worker
        self.storage = storage
        self.simulator = simulator
        self.framebuffer = FramebufferOutput.from_env()
        self.touch = TouchInput.from_env()
        self.native_window: pygame.Window | None = None
        if simulator and pygame.display.get_driver() != "dummy":
            self.native_window = pygame.Window(
                title="Cloudy · Virtual Pod",
                size=SIMULATOR_SIZE,
                borderless=True,
                allow_high_dpi=True,
            )
            self.window = self.native_window.get_surface()
            self.window_size = self.native_window.size
        else:
            self.window = pygame.display.set_mode(
                SIMULATOR_SIZE if simulator else self.framebuffer.size if self.framebuffer else LOGICAL_SIZE,
                pygame.NOFRAME if simulator or self.framebuffer else pygame.FULLSCREEN,
            )
            self.window_size = self.window.get_size()
            pygame.display.set_caption("Cloudy · Virtual Pod")
        self.render_scale = self.window.get_width() / LOGICAL_SIZE[0]
        self.surface = pygame.Surface(
            self.window_size
        )
        self.font = self._font(POD_TYPE_SCALE["body"])
        self.small = self._font(POD_TYPE_SCALE["label"], MONO_FONT_PATH)
        self.heading = self._font(POD_TYPE_SCALE["display"])
        self.idle_font = self._font(POD_TYPE_SCALE["idle"])
        self.review_title = self._font(POD_TYPE_SCALE["title"])
        self.review_body = self._font(POD_TYPE_SCALE["review_body"])
        self.review_detail = self._font(POD_TYPE_SCALE["detail_body"])
        self.review_label = self.small
        self.notification_title = self._font(POD_TYPE_SCALE["notification_title"])
        self.notification_body = self._font(POD_TYPE_SCALE["notification_body"])
        self.notification_label = self._font(POD_TYPE_SCALE["notification_label"], MONO_FONT_PATH)
        self.detail_label = self._font(POD_TYPE_SCALE["detail_label"], MONO_FONT_PATH)
        self.code_font = self._font(POD_TYPE_SCALE["code"], MONO_FONT_PATH)
        self.demo_mode = os.getenv("CLOUDY_DEMO", "")
        self.demo = self.demo_mode in ("github-pr", "email-chat")
        saved_request = storage.request()
        if self.demo_mode == "email-chat":
            self.state = "email_chat"
        elif self.demo:
            self.state = "request"
        else:
            self.state = "offline" if saved_request else "startup"
        self.request = GITHUB_DEMO_REQUEST if self.demo_mode == "github-pr" else saved_request
        self.queue_size = 2 if self.demo_mode == "github-pr" else 0
        self.pairing_code = ""
        self.message = "Starting Pod…"
        self.scroll = 0
        self.scroll_limit = 4000
        self.review_page = 0
        self.detail_scroll = 0
        self.detail_scroll_limit = 4000
        self.review_transition: tuple[float, int, int] | None = None
        self.swipe_start: tuple[int, int] | None = None
        saved_settings = storage.settings() or {}
        brightness = saved_settings.get("brightness", 100)
        volume = saved_settings.get("volume", 50)
        self.brightness = brightness if isinstance(brightness, int) and 10 <= brightness <= 100 else 100
        self.volume = volume if isinstance(volume, int) and 0 <= volume <= 100 else 50
        self.reduce_motion = saved_settings.get("reduce_motion") if isinstance(saved_settings.get("reduce_motion"), bool) else os.getenv("CLOUDY_REDUCED_MOTION") == "1"
        self.last_interaction_at = time.monotonic()
        self.dragging = False
        self.needs_render = True
        self.offline = False
        self.result_until = 0.0
        self.result_started = 0.0
        self.pending_request_event: dict[str, Any] | None = None
        self.mascot_action: str | None = None
        self.mascot_action_started = 0.0
        self.buttons: list[Any] = []
        self.codex: dict[str, Any] = {}
        self.screen_layout = DEFAULT_SCREEN_LAYOUT
        self.screen = "home"
        self.notification_screen = "home"
        self.quick_settings = False
        self.settings_slider: str | None = None
        self.transcript = ""
        self.voice_revision_request: dict[str, Any] | None = None
        self.recorder = Recorder(storage.root)
        self.chord = ButtonChord(self.choose, self.start_recording, self.stop_recording)
        self.wrap_cache: dict[tuple[int, str, int, int | None], list[str]] = {}
        self.idle_mascots = (high_res_mascot(False), high_res_mascot(True))
        self.idle_stage = pygame.Surface((round(280 * self.render_scale),) * 2, pygame.SRCALPHA)
        self.yawn_mouth = pygame.Surface((128, 128), pygame.SRCALPHA)
        pygame.draw.ellipse(self.yawn_mouth, BACKGROUND, self.yawn_mouth.get_rect())
        self._apply_volume()

    def _font(self, size: int, path: Path = FONT_PATH) -> pygame.font.Font:
        return pygame.font.Font(path, max(1, round(size * self.render_scale)))

    def _point(self, x: float, y: float) -> tuple[int, int]:
        return round(x * self.render_scale), round(y * self.render_scale)

    def _rect(self, x: float, y: float, width: float, height: float) -> pygame.Rect:
        return pygame.Rect(*self._point(x, y), *self._point(width, height))

    def _blit(self, image: pygame.Surface, x: float, y: float) -> None:
        self.surface.blit(image, self._point(x, y))

    def _line(self, color: pygame.Color, start: tuple[float, float], end: tuple[float, float]) -> None:
        pygame.draw.line(self.surface, color, self._point(*start), self._point(*end), max(1, round(self.render_scale)))

    def _circle(self, color: pygame.Color, center: tuple[float, float], radius: float) -> None:
        pygame.draw.circle(self.surface, color, self._point(*center), round(radius * self.render_scale))

    def _feed_icon(self, feed_id: str, x: int, y: int) -> None:
        color = MUTED
        width = max(1, round(self.render_scale))
        rect = lambda left, top, wide, high: self._rect(x + left, y + top, wide, high)
        point = lambda left, top: self._point(x + left, y + top)
        line = lambda start, end: pygame.draw.line(self.surface, color, point(*start), point(*end), width)

        if feed_id == "calendar":
            pygame.draw.rect(self.surface, color, rect(1, 3, 16, 14), width, border_radius=2 * width)
            line((1, 7), (17, 7)); line((5, 1), (5, 5)); line((13, 1), (13, 5))
            for column, row in ((5, 10), (9, 10), (13, 10), (5, 14), (9, 14), (13, 14)):
                self._circle(color, (x + column, y + row), 0.8)
        elif feed_id == "notion":
            pygame.draw.rect(self.surface, color, rect(3, 1, 13, 16), width, border_radius=2 * width)
            line((1, 5), (5, 5)); line((1, 9), (5, 9)); line((1, 13), (5, 13))
            line((7, 6), (12, 6)); line((7, 10), (12, 10)); line((7, 14), (11, 14))
        elif feed_id == "gmail":
            pygame.draw.rect(self.surface, color, rect(1, 3, 16, 12), width, border_radius=2 * width)
            line((2, 5), (9, 10)); line((16, 5), (9, 10))
        elif feed_id == "important":
            pygame.draw.arc(self.surface, color, rect(3, 2, 12, 13), math.pi, math.tau, width)
            line((3, 8), (3, 13)); line((15, 8), (15, 13)); line((3, 13), (15, 13))
            self._circle(color, (x + 9, y + 16), 1)
        elif feed_id == "github":
            line((4, 3), (4, 15)); line((14, 3), (14, 8)); line((4, 9), (14, 9))
            for center in ((4, 3), (4, 15), (14, 3), (14, 9)):
                self._circle(color, (x + center[0], y + center[1]), 2)
        elif feed_id == "deployments":
            pygame.draw.polygon(self.surface, color, [point(5, 12), point(8, 4), point(15, 1), point(12, 8)], width)
            self._circle(color, (x + 11, y + 5), 1.5)
            line((6, 12), (3, 15)); line((8, 14), (5, 17)); line((11, 10), (15, 9))
        elif feed_id == "slack":
            pygame.draw.rect(self.surface, color, rect(2, 3, 15, 11), width, border_radius=3 * width)
            line((6, 14), (5, 17)); line((5, 17), (10, 14))
            line((6, 7), (13, 7)); line((6, 10), (11, 10))
        else:
            line((3, 5), (9, 9)); line((9, 9), (15, 4)); line((9, 9), (15, 15))
            for center in ((3, 5), (9, 9), (15, 4), (15, 15)):
                self._circle(color, (x + center[0], y + center[1]), 2)

    def start_gpio(self) -> None:
        if self.simulator or os.getenv("CLOUDY_BUTTONS", "1") == "0":
            return
        from gpiozero import Button

        approve = Button(int(os.getenv("CLOUDY_APPROVE_PIN", "5")), pull_up=True, bounce_time=0.05)
        reject = Button(int(os.getenv("CLOUDY_REJECT_PIN", "6")), pull_up=True, bounce_time=0.05)
        approve.when_pressed = lambda: self.chord.press("approve")
        approve.when_released = lambda: self.chord.release("approve")
        reject.when_pressed = lambda: self.chord.press("reject")
        reject.when_released = lambda: self.chord.release("reject")
        self.buttons = [approve, reject]

    def choose(self, outcome: str) -> None:
        self.needs_render = True
        self.last_interaction_at = time.monotonic()
        if self.demo_mode == "email-chat":
            if self.state == "email_chat":
                self.state = "email_sent" if outcome == "approved" else "email_discarded"
            elif self.state in ("email_sent", "email_discarded"):
                self.state = "email_chat"
                self.review_page = 0
                self.detail_scroll = 0
                self.review_transition = None
            return
        if self.demo:
            return
        if self.state == "transcript":
            if outcome == "approved":
                revision_request = self.voice_revision_request
                if revision_request and revision_request.get("action_payload", {}).get("mock_type") == "codex":
                    codex_payload = {**revision_request.get("codex_payload", {}), "revision_note": self.transcript}
                    self.request = {**revision_request, "codex_payload": codex_payload}
                    self.transcript = ""
                    self.voice_revision_request = None
                    self.review_page = 1
                    self.detail_scroll = 0
                    self.state = "request"
                    return
                target = self.codex.get("target") or {}
                revision = target.get("revision")
                if not revision:
                    self.state = "error"
                    self.message = "Choose a Codex target"
                    return
                self.worker.prompt(self.transcript, revision, self.voice_revision_request)
                self.voice_revision_request = None
                self.state = "queued"
            else:
                self.transcript = ""
                self.state = "request" if self.voice_revision_request else "idle"
                self.voice_revision_request = None
            return
        if self.state == "idle" and outcome == "approved":
            self.play_mascot_action("yawn")
            return
        if self.state != "request" or self.offline or not self.request:
            return
        if self._expired():
            self.state = "expired"
            return
        self.state = "submitting"
        self.message = "Approving…" if outcome == "approved" else "Rejecting…"
        self.worker.decide(self.request, outcome)

    def start_recording(self) -> None:
        self.needs_render = True
        self.last_interaction_at = time.monotonic()
        if self.demo or self.offline or self.state in ("pairing", "startup", "submitting", "transcribing"):
            return
        try:
            payload = self.request.get("codex_payload", {}) if self.request else {}
            self.voice_revision_request = self.request if payload.get("plan") else None
            self.recorder.start()
            self.state = "recording"
        except OSError:
            self.state = "error"
            self.message = "Microphone unavailable"

    def stop_recording(self) -> None:
        self.needs_render = True
        if self.state != "recording":
            return
        path = self.recorder.stop()
        if path:
            self.worker.transcribe(str(path))
            self.state = "transcribing"

    def toggle_offline(self) -> None:
        self.needs_render = True
        self.offline = not self.offline
        self.worker.set_offline(self.offline)
        if self.offline:
            self.state = "offline"

    def apply_worker_events(self) -> None:
        while True:
            try:
                event = self.worker.events.get_nowait()
            except queue.Empty:
                return
            self.needs_render = True
            kind = event["event"]
            if kind == "pairing":
                self.pairing_code = event["pairing_code"]
                self.state = "pairing"
            elif kind in ("paired", "idle"):
                self.state = "idle"
                self.request = None
                self.screen = "home"
                self.quick_settings = False
                self.settings_slider = None
                self.last_interaction_at = time.monotonic()
            elif kind == "request":
                if self.state in ("approved", "rejected") and time.monotonic() < self.result_until:
                    self.pending_request_event = event
                    continue
                self.request = event["request"]
                direction = event.get("request_screen", "down")
                self.notification_screen = "home" if direction == "down" else direction
                self.screen = self.notification_screen
                self.quick_settings = False
                self.settings_slider = None
                self.wrap_cache.clear()
                self.queue_size = event["queue_size"]
                self.scroll = 0
                self.review_page = 0
                self.detail_scroll = 0
                self.review_transition = None
                self.state = "request"
            elif kind == "decided":
                self.state = event["outcome"]
                self.request = None
                self.screen = "home"
                self.result_started = time.monotonic()
                self.result_until = self.result_started + DECISION_ANIMATION_SECONDS
            elif kind == "codex":
                self.codex = event["codex"]
            elif kind == "screen_layout":
                self.screen_layout = event["screen_layout"]
            elif kind == "mascot_action":
                self.play_mascot_action(event["action"])
            elif kind == "screen_navigation":
                self.navigate_screen(event["direction"])
            elif kind == "transcript":
                self.transcript = event["transcript"]
                self.wrap_cache.clear()
                self.state = "transcript"
            elif kind == "prompt_queued":
                self.transcript = ""
                self.state = "queued"
            elif kind == "offline":
                self.state = "offline"
            elif kind == "reconnecting":
                self.state = "startup"
                self.message = "Reconnecting…"

            elif kind == "revoked":
                self.request = None
                self.state = "revoked"
                self.result_until = time.monotonic() + 1.3
            elif kind == "error":
                self.state = "error"
                self.message = event["message"]

    def _complete_decision_result(self) -> None:
        self.result_until = 0
        self.state = "idle"
        if self.pending_request_event:
            self.worker.events.put(self.pending_request_event)
            self.pending_request_event = None
        self.needs_render = True

    def navigate_screen(self, direction: str) -> None:
        if self.state not in ("idle", "request") or self.quick_settings:
            if direction == "down" and self.quick_settings:
                self.quick_settings = False
                self.last_interaction_at = time.monotonic()
            return
        active_notification = self.state == "request" and self.screen == self.notification_screen
        details_open = self.review_page == 1 or bool(self.review_transition and self.review_transition[2] == 1)
        if direction == "left":
            self.screen = "home" if self.screen == "right" else "left" if self.screen == "home" else self.screen
        elif direction == "right":
            self.screen = "home" if self.screen == "left" else "right" if self.screen == "home" else self.screen
        elif direction == "up":
            if active_notification:
                if self.review_page == 0:
                    self._show_review_page(1)
            else:
                self.quick_settings = True
        elif direction == "down":
            if active_notification and self.review_page == 1:
                self._show_review_page(0)
            else:
                self.quick_settings = False
        elif direction == "scroll_up" and active_notification and details_open:
            self._scroll_detail_by(-240)
        elif direction == "scroll_down" and active_notification and details_open:
            self._scroll_detail_by(240)
        self.last_interaction_at = time.monotonic()

    def _text(self, value: str, x: int, y: int, font: pygame.font.Font | None = None, color: pygame.Color = INK) -> int:
        selected = font or self.font
        image = selected.render(value, True, color)
        self._blit(image, x - 20 if x <= 46 else x, y)
        return y + round(selected.get_linesize() / self.render_scale)

    def _wrapped(
        self,
        value: str,
        x: int,
        y: int,
        width: int,
        font: pygame.font.Font | None = None,
        color: pygame.Color = INK,
        max_lines: int | None = None,
    ) -> int:
        selected = font or self.font
        width = width + 40 if x <= 46 else width
        key = (id(selected), value, width, max_lines)
        lines = self.wrap_cache.setdefault(
            key,
            wrap(selected, value, width * self.render_scale, max_lines),
        )
        for line in lines:
            y = self._text(line, x, y, selected, color)
        return y

    def _status(self, label: str, color: pygame.Color, font: pygame.font.Font | None = None) -> None:
        self._circle(color, (12, 27), 5)
        self._text(label.upper(), 46, 13, font or self.small, MUTED)
        self._line(DIVIDER, (6, 50), (634, 50))

    def _render_decision_result(self, accepted: bool) -> None:
        elapsed = time.monotonic() - self.result_started
        progress = 1.0 if self.reduce_motion else min(1.0, elapsed / 0.75)
        eased = 1 - (1 - progress) ** 3
        color = GREEN if accepted else CLAY
        flash = 0 if self.reduce_motion else max(0.0, 1 - elapsed / 0.28)
        self.surface.fill(BACKGROUND.lerp(color, flash * 0.16))
        self._status("Decision saved", color)
        stroke = lambda start, end: pygame.draw.line(
            self.surface,
            color,
            self._point(*start),
            self._point(*end),
            max(2, round(6 * self.render_scale)),
        )

        shake = 0 if accepted or self.reduce_motion else math.sin(elapsed * 38) * 12 * max(0, 1 - elapsed / 0.8)
        center = (320 + shake, 190)
        radius = 22 + 42 * eased
        pygame.draw.circle(
            self.surface,
            color,
            self._point(*center),
            round(radius * self.render_scale),
            max(2, round(5 * self.render_scale)),
        )
        if accepted:
            if not self.reduce_motion:
                for index in range(8):
                    angle = index * math.tau / 8
                    distance = 70 + 18 * eased
                    self._circle(
                        color,
                        (center[0] + math.cos(angle) * distance, center[1] + math.sin(angle) * distance),
                        2.5,
                    )
            check = min(1.0, max(0.0, (progress - 0.25) / 0.55))
            start = (center[0] - 28, center[1])
            middle = (center[0] - 8, center[1] + 20)
            end = (center[0] + 32, center[1] - 25)
            if check <= 0.34:
                amount = check / 0.34
                target = (
                    start[0] + (middle[0] - start[0]) * amount,
                    start[1] + (middle[1] - start[1]) * amount,
                )
                stroke(start, target)
            else:
                stroke(start, middle)
                amount = (check - 0.34) / 0.66
                target = (
                    middle[0] + (end[0] - middle[0]) * amount,
                    middle[1] + (end[1] - middle[1]) * amount,
                )
                stroke(middle, target)
        else:
            cross = 34 * min(1.0, max(0.0, (progress - 0.18) / 0.5))
            stroke((center[0] - cross, center[1] - cross), (center[0] + cross, center[1] + cross))
            stroke((center[0] + cross, center[1] - cross), (center[0] - cross, center[1] + cross))

        title = self.heading.render("Approved" if accepted else "Rejected", True, color)
        self.surface.blit(title, title.get_rect(center=self._point(320, 312)))
        detail = self.small.render("Ready for the next Ping" if accepted else "Nothing was sent", True, MUTED)
        self.surface.blit(detail, detail.get_rect(center=self._point(320, 362)))

    def render(self) -> pygame.Surface:
        self.surface.fill(BACKGROUND)
        if self._mascot_action_active():
            self._render_idle(self.mascot_action)
        elif self.state == "pairing":
            self._status("Ready to pair", AMBER)
            self._text("Pair your Pod", 36, 130, self.heading)
            self._wrapped("Enter the code shown here in the Cloudy dashboard.", 36, 188, 270, self.font, MUTED)
            code_image = self.code_font.render(self.pairing_code, True, INK)
            self.surface.blit(code_image, code_image.get_rect(center=self._point(480, 190)))
            self._wrapped("Expires after 10 minutes.", 386, 245, 200, self.small, MUTED)
        elif self.quick_settings:
            self._render_quick_settings()
        elif self.state == "idle" or self.state == "request" and self.screen != self.notification_screen:
            self._render_screen_layout()
        elif self.state == "email_chat":
            self._render_email_chat()
        elif self.state in ("email_sent", "email_discarded"):
            self._render_email_result()
        elif self.state == "codex":
            self._render_codex()
        elif self.state == "target_unavailable":
            self._status("Codex target unavailable", CLAY)
            self._text("Choose another session", 36, 180, self.heading)
            self._wrapped("Open the Codex page in Cloudy and select an online workspace and session.", 38, 238, 560, self.font, MUTED)
        elif self.state in ("recording", "transcribing", "queued"):
            labels = {"recording": ("Listening", "Release both buttons to stop."), "transcribing": ("Transcribing", "Turning your voice into a Codex prompt."), "queued": ("Prompt queued", "Codex will prepare a plan first.")}
            title, detail = labels[self.state]
            self._status(title, CLAY if self.state == "recording" else AMBER)
            self._text(title, 36, 180, self.heading)
            self._wrapped(detail, 38, 238, 560, self.font, MUTED)
        elif self.state == "transcript":
            self._status("Confirm voice prompt", GREEN)
            self._text("Send this to Codex?", 28, 74, self.review_title)
            self.surface.set_clip(self._rect(0, 120, 640, 300))
            self._wrapped(self.transcript, 30, 132 - self.scroll, 580, self.review_body)
            self.surface.set_clip(None)
            self._line(DIVIDER, (24, 420), (616, 420))
            self._text("Approve sends · Reject discards", 30, 438, self.small, MUTED)
        elif self.state in ("approved", "rejected"):
            self._render_decision_result(self.state == "approved")
        elif self.state == "revoked":
            self._status("Unpaired", CLAY)
            self._text("Pod access revoked", 36, 188, self.heading)
            self._wrapped("Returning to pairing…", 38, 246, 560, self.font, MUTED)
        elif self.state == "startup":
            label = self.heading.render("Starting", True, INK)
            self.surface.blit(label, label.get_rect(center=self._point(320, 218)))
            active_dot = pygame.time.get_ticks() // 350 % 3
            for index, x in enumerate((300, 320, 340)):
                self._circle(INK if index == active_dot else DIVIDER, (x, 264), 4)
        elif self.state in ("submitting", "error"):
            self._status("Error" if self.state == "error" else "Working", CLAY if self.state == "error" else AMBER)
            self._text(self.message, 36, 188, self.heading if len(self.message) < 22 else self.font)
            if self.state == "error":
                self._wrapped("Pod will retry automatically.", 38, 246, 560, self.font, MUTED)
        else:
            self._render_request(self.state == "offline")
        if self.brightness < 100:
            shade = pygame.Surface(self.surface.get_size(), pygame.SRCALPHA)
            shade.fill((0, 0, 0, round((100 - self.brightness) * 1.8)))
            self.surface.blit(shade, (0, 0))
        return self.surface

    def _render_email_chat(self) -> None:
        self._render_email_review(EMAIL_CHAT_DEMO, False, False)

    def _render_email_review(self, presentation: dict[str, Any], offline: bool, expired: bool) -> None:
        self._circle(CLAY if offline or expired else AMBER, (32, 27), 4)
        sender = presentation.get("sender") or "Unknown sender"
        time_label = presentation.get("time") or "Unknown time"
        self._wrapped(f"{sender} · {time_label}", 46, 17, 560, self.notification_label, MUTED, max_lines=1)
        self._line(DIVIDER, (24, 50), (616, 50))
        self.surface.set_clip(self._rect(0, 52, 640, 428))
        glance_y, detail_y = self._review_page_offsets()
        self._render_email_glance(presentation, glance_y)
        self._render_email_detail(presentation, detail_y)
        self.surface.set_clip(None)

    def _render_email_glance(self, presentation: dict[str, Any], offset: int) -> None:
        y = self._wrapped(str(presentation.get("subject") or "Email needs you"), 28, 70 + offset, 520, self.review_title, max_lines=2)
        y = self._wrapped(str(presentation.get("summary") or "Review the email and response."), 30, y + 18, 580, self.review_body)
        y += 20
        self._line(DIVIDER, (28, y), (612, y))
        response = presentation.get("response")
        self._wrapped(str(response or presentation.get("email") or "The email is unavailable."), 30, y + 24, 580, self.review_body, max_lines=6)

    def _render_email_detail(self, presentation: dict[str, Any], offset: int) -> None:
        y = self._text("Details", 46, 62 + offset - self.detail_scroll, self.notification_title)
        y = self._wrapped(str(presentation.get("email") or "The original email is unavailable."), 46, y + 4, 560, self.review_detail)
        if presentation.get("response"):
            y += 20
            self._line(DIVIDER, (28, y), (612, y))
            y = self._wrapped(str(presentation["response"]), 46, y + 20, 560, self.review_detail)
        content_bottom = y - offset + self.detail_scroll
        self.detail_scroll_limit = max(0, content_bottom + 18 - 474)

    def _render_email_result(self) -> None:
        sent = self.state == "email_sent"
        self._status("Reply sent" if sent else "Draft discarded", GREEN if sent else CLAY)
        self._text("Reply sent" if sent else "Nothing sent", 36, 174, self.heading, GREEN if sent else INK)
        self._wrapped(
            "Aniket received the reply and updated invite." if sent else "The draft was discarded. Aniket did not receive a reply.",
            38,
            232,
            560,
            self.font,
            MUTED,
        )
        self._line(DIVIDER, (24, 410), (616, 410))
        self._text("Press either button to replay", 30, 432, self.small, MUTED)

    def play_mascot_action(self, action: str) -> None:
        self.mascot_action = action
        self.mascot_action_started = time.monotonic()
        self.needs_render = True

    def _mascot_action_active(self) -> bool:
        if not self.mascot_action:
            return False
        if time.monotonic() - self.mascot_action_started < MASCOT_ACTION_DURATIONS[self.mascot_action]:
            return True
        self.mascot_action = None
        return False

    def _render_idle(self, action: str | None = None) -> None:
        mouth_openness = 0.0
        if action:
            elapsed = time.monotonic() - self.mascot_action_started
            float_offset, size, blinking, mouth_openness = mascot_action_pose(action, elapsed)
        else:
            float_offset, size, blinking = idle_pose(pygame.time.get_ticks() / 1000)
        render_size = round(size * self.render_scale)
        mascot = pygame.transform.smoothscale(self.idle_mascots[blinking], (render_size, render_size))
        if mouth_openness:
            mouth_size = (round(render_size * 0.14), max(2, round(render_size * 0.15 * mouth_openness)))
            mouth = pygame.transform.smoothscale(self.yawn_mouth, mouth_size)
            mascot.blit(mouth, mouth.get_rect(center=(render_size // 2, round(render_size * 0.69))))
        self.idle_stage.fill((0, 0, 0, 0))
        stage_center = self._point(140, 140)
        self.idle_stage.blit(mascot, mascot.get_rect(center=stage_center))
        self.surface.blit(self.idle_stage, self.idle_stage.get_rect(center=self._point(320, 202 + float_offset)))

        if action == "sleep":
            for label, x, y in (("z", 428, 172), ("Z", 464, 128), ("Z", 505, 78)):
                self._text(label, x, y, self.heading if label == "Z" else self.font, MASCOT_TOP)

        labels = {"blink": "Blink!", "yawn": "Big yawn", "sleep": "Shhh…", "jump": "Boing!"}
        label = self.idle_font.render(labels.get(action, "All caught up"), True, INK)
        self.surface.blit(label, label.get_rect(center=self._point(320, 420)))
        hint = self.small.render("Swipe left or right", True, MUTED)
        self.surface.blit(hint, hint.get_rect(center=self._point(320, 460)))

    def _render_screen_layout(self) -> None:
        self._render_idle()

    def _render_quick_settings(self) -> None:
        self._status("Quick settings", GREEN)
        self._text("Pod settings", 28, 72, self.review_title)
        rows = (
            ("CONNECTION", "Offline · cached only" if self.offline else "Online"),
            ("BRIGHTNESS", f"{self.brightness}%"),
            ("VOLUME", f"{self.volume}%"),
            ("MOTION", "Reduced" if self.reduce_motion else "Full"),
        )
        y = 116
        for label, value in rows:
            self._text(label, 30, y, self.review_label, MUTED)
            if label in ("BRIGHTNESS", "VOLUME"):
                self._text(value, 240, y - 2, self.review_body)
                percent = self.brightness if label == "BRIGHTNESS" else self.volume
                self._line(DIVIDER, (360, y + 10), (600, y + 10))
                self._line(GREEN, (360, y + 10), (360 + percent * 2.4, y + 10))
                self._circle(INK, (360 + percent * 2.4, y + 10), 7)
            else:
                self._wrapped(value, 240, y - 2, 370, self.review_body, max_lines=1)
            self._line(DIVIDER, (28, y + 30), (612, y + 30))
            y += 52
        self._text("Tap to change · Swipe down to return", 30, 448, self.small, MUTED)

    def _change_quick_setting(self, point: tuple[int, int]) -> None:
        row = (point[1] - 96) // 52
        if row == 0:
            self.toggle_offline()
            return
        if row in (1, 2):
            return
        if row == 3:
            self.reduce_motion = not self.reduce_motion
        else:
            return
        self._save_settings()

    def _set_slider(self, point: tuple[int, int], persist: bool = False) -> None:
        fraction = min(1, max(0, (point[0] - 360) / 240))
        value = round(fraction * 20) * 5
        if self.settings_slider == "brightness":
            self.brightness = max(10, value)
        elif self.settings_slider == "volume":
            self.volume = value
            if persist:
                self._apply_volume()
        if persist:
            self._save_settings()

    def _save_settings(self) -> None:
        self.storage.save_settings({
            "brightness": self.brightness,
            "volume": self.volume,
            "reduce_motion": self.reduce_motion,
        })

    def _apply_volume(self) -> None:
        if self.simulator:
            return
        try:
            subprocess.run(
                ["amixer", "sset", "Master", f"{self.volume}%"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    def _render_codex(self) -> None:
        thread = self.codex.get("thread") or {}
        status = thread.get("status", "idle")
        self._status(f"Codex · {status}", CLAY if status == "error" else GREEN)
        self._wrapped(thread.get("title", "Codex session"), 28, 82, 584, self.review_title)
        self._wrapped(thread.get("last_error") or (thread.get("final_summary") if status == "completed" else thread.get("milestone")) or "Ready for your next voice task.", 30, 150, 580, self.review_body)
        self._line(DIVIDER, (24, 410), (616, 410))
        self._wrapped("Hold both buttons to speak.", 30, 432, 580, self.small, MUTED)

    def _render_request(self, offline: bool) -> None:
        if not self.request:
            self._status("Offline" if offline else "Waiting", CLAY if offline else AMBER)
            self._text("No cached Ping", 36, 188, self.heading)
            self._wrapped("Reconnect to check the approval queue.", 38, 246, 560, self.font, MUTED)
            return

        expired = self._expired()
        presentation = self.request.get("presentation") or {}
        if presentation.get("kind") == "github_pr_v1":
            request = self.request
            self.request = {**request, **presentation}
            try:
                self._render_fact_request(offline, expired)
            finally:
                self.request = request
            return
        if presentation.get("kind") in ("email_reply_v1", "gmail_notification_v1"):
            self._render_email_review(presentation, offline, expired)
            return
        if presentation.get("kind") == "codex_plan_v1":
            if self.review_page == 1:
                self._render_notification_details(offline, expired)
            else:
                self._render_codex_plan_request(presentation, offline, expired)
            return
        if presentation:
            if self.review_page == 1:
                self._render_notification_details(offline, expired)
            else:
                self._render_ping_action_request(offline, expired)
            return
        if self.request.get("facts"):
            self._render_fact_request(offline, expired)
            return
        if self.review_page == 1:
            self._render_notification_details(offline, expired)
            return
        label = "Expired" if expired else "Offline · read only" if offline else f"Ping 1 of {max(self.queue_size, 1)}"
        self._status(label, CLAY if offline or expired else AMBER)
        self.surface.set_clip(self._rect(0, 52, 640, 428))
        y = 70 - self.scroll
        y = self._wrapped(self.request["title"], 28, y, 584, self.heading)
        y = self._wrapped(self.request["source"], 30, y + 6, 580, self.small, MUTED)
        risk = self.request["risk"].upper()
        badge = self.small.render(f"{risk} RISK", True, BACKGROUND)
        badge_width = badge.get_width() / self.render_scale + 26
        pygame.draw.rect(
            self.surface,
            CLAY if risk == "HIGH" else AMBER,
            self._rect(30, y + 18, badge_width, 28),
            border_radius=round(14 * self.render_scale),
        )
        self._blit(badge, 43, y + 23)
        y += 72
        y = self._wrapped(self.request["summary"], 30, y, 580)
        self.surface.set_clip(None)

        if offline or expired:
            pygame.draw.rect(self.surface, BACKGROUND, self._rect(0, 418, 640, 62))
            self._line(DIVIDER, (24, 418), (616, 418))
            self._wrapped("Reconnect before deciding." if offline else "This Ping can no longer be decided.", 30, 436, 580, self.small, CLAY)

    def _render_ping_action_request(self, offline: bool, expired: bool) -> None:
        assert self.request is not None
        payload = self.request.get("presentation") or {}
        accent = CLAY if offline or expired or self.request.get("risk") == "high" else AMBER
        self.surface.set_clip(self._rect(0, 0, 640, 480))
        self._circle(accent, (13, 35), 5)
        y = self._wrapped(self.request.get("title", "Message needs you"), 46, 18, 560, self.notification_title, max_lines=2)
        y = self._wrapped(f"{payload.get('sender', self.request.get('source', 'Connected service'))} · {payload.get('destination', 'Approval')}", 46, y + 2, 560, self.notification_label, MUTED, max_lines=1)
        self._line(DIVIDER, (26, y + 14), (614, y + 14))
        y = self._text("INCOMING", 46, y + 30, self.notification_label, MUTED)
        y = self._wrapped(str(payload.get("excerpt", "A new event matched this Ping.")), 46, y + 6, 560, self.notification_body, max_lines=3)
        action = payload.get("proposed_reply") or payload.get("recommended_action")
        if action:
            label = "EXACT PROPOSED REPLY" if payload.get("proposed_reply") else "RECOMMENDED ACTION"
            y = self._text(label, 46, y + 20, self.notification_label, CLAY)
            self._wrapped(str(action), 46, y + 6, 560, self.notification_body, max_lines=3)
        else:
            y = self._text("WHAT APPROVAL DOES", 46, y + 20, self.notification_label, GREEN)
            self._wrapped(str(payload.get("summary", "No external write will run.")), 46, y + 6, 560, self.notification_body, max_lines=3)
        self.surface.set_clip(None)
        if offline or expired:
            pygame.draw.rect(self.surface, BACKGROUND, self._rect(0, 410, 640, 70))
            self._line(DIVIDER, (24, 410), (616, 410))
            self._wrapped("Reconnect before deciding." if offline else "This Ping can no longer be decided.", 30, 430, 580, self.small, CLAY)

    def _render_notification_details(self, offline: bool, expired: bool) -> None:
        assert self.request is not None
        presentation = self.request.get("presentation") or {}
        self._status("Notification details", CLAY if offline or expired else GREEN, self.detail_label)
        self.surface.set_clip(self._rect(0, 52, 640, 428))
        y = self._text("Details", 46, 66 - self.detail_scroll, self.notification_title)
        for heading, value in (
            ("SUMMARY", self.request.get("summary", "")),
            ("DETAILS", self.request.get("details", "")),
            ("AFFECTED", self.request.get("affected_context", "")),
            ("PROPOSED REPLY", presentation.get("proposed_reply", "")),
            ("WARNINGS", " · ".join(map(str, presentation.get("warnings") or self.request.get("warnings", [])))),
            ("FULL PLAN", (self.request.get("codex_payload") or {}).get("plan", "")),
            ("DICTATED REVISION", (self.request.get("codex_payload") or {}).get("revision_note", "")),
        ):
            if value:
                y = self._text(heading, 46, y + 16, self.detail_label, MUTED)
                y = self._wrapped(str(value), 46, y + 6, 560, self.review_detail)
        self.detail_scroll_limit = max(0, y + self.detail_scroll - 462)
        self.surface.set_clip(None)

    def _render_codex_plan_request(self, presentation: dict[str, Any], offline: bool, expired: bool) -> None:
        self._status("Codex plan", CLAY if offline or expired else GREEN)
        self.surface.set_clip(self._rect(0, 52, 640, 386))
        y = self._wrapped(str(presentation.get("title") or self.request["title"]), 28, 68, 584, self.review_title, max_lines=2)
        y = self._wrapped(str(presentation.get("workspace") or "Cloudy workspace"), 30, y + 4, 580, self.small, MUTED)
        self._line(DIVIDER, (30, y + 16), (610, y + 16))
        y = self._text("SUMMARY", 30, y + 32, self.small, GREEN)
        y = self._wrapped(str(presentation.get("summary") or self.request.get("summary") or "Codex prepared a plan for review."), 30, y + 8, 580, self.review_body, max_lines=6)
        note = (self.request.get("codex_payload") or {}).get("revision_note")
        if note:
            y = self._text("DICTATED REVISION", 30, y + 14, self.small, CLAY)
            self._wrapped(str(note), 30, y + 6, 580, self.review_body, max_lines=2)
        self.surface.set_clip(None)
        if not offline and not expired:
            self._text("Hold both buttons to dictate a revision", 30, 450, self.small, MUTED)

    def _render_fact_request(self, offline: bool, expired: bool) -> None:
        assert self.request is not None
        self._status(self.request["source"], CLAY if offline or expired else GREEN)
        count = self.small.render(f"1 / {max(self.queue_size, 1)}", True, MUTED)
        count_x = 616 - count.get_width() / self.render_scale
        self._blit(count, count_x, 15)
        risk = self.request["risk"].upper()
        badge = self.review_label.render(f"{risk} RISK", True, BACKGROUND)
        badge_width = badge.get_width() / self.render_scale + 20
        badge_x = count_x - badge_width - 14
        pygame.draw.rect(
            self.surface,
            AMBER,
            self._rect(badge_x, 13, badge_width, 26),
            border_radius=round(13 * self.render_scale),
        )
        self._blit(badge, badge_x + 10, 18)

        self.surface.set_clip(self._rect(0, 52, 640, 428))
        glance_y, detail_y = self._review_page_offsets()
        self._render_glance_page(glance_y)
        self._render_detail_page(detail_y)
        self.surface.set_clip(None)

    def _render_glance_page(self, offset: int) -> None:
        assert self.request is not None
        y = self._wrapped(self.request["title"], 28, 64 + offset, 584, self.review_title)
        y = self._wrapped(self.request["context"], 30, y + 2, 580, self.review_label, MUTED)
        y += 10
        self._line(DIVIDER, (28, y), (612, y))

        column_width = 584 // 4
        for index, (label, value) in enumerate(self.request["facts"]):
            row, column = divmod(index, 4)
            x = 30 + column * column_width
            value_color = GREEN if label in ("CHECKS", "REVIEWS") else AMBER if label in ("AREA", "EXPIRES") else INK
            self._inline_pair(label, value, x, y + 14 + row * 28, value_color)
        y += 72
        self._line(DIVIDER, (28, y), (612, y))

        y = self._wrapped(
            self.request["summary"],
            30,
            y + 15,
            580,
            self.review_detail,
            max_lines=6,
        )
        for label, value in self.request["glance_details"]:
            self._inline_pair(label, value, 30, y + 9, INK)
            y += 27

    def _inline_pair(self, label: str, value: str, x: int, y: int, value_color: pygame.Color) -> None:
        label_image = self.review_label.render(label, True, MUTED)
        self._blit(label_image, x, y)
        value_image = self.review_label.render(value, True, value_color)
        self._blit(value_image, x + label_image.get_width() / self.render_scale + 8, y)

    def _render_detail_page(self, offset: int) -> None:
        assert self.request is not None
        y = self._text("Full review", 46, 66 + offset - self.detail_scroll, self.notification_title)
        y = self._text("#482 · cloudy/api", 46, y + 4, self.detail_label, MUTED)
        y += 14
        self._line(DIVIDER, (28, y), (612, y))
        for label, value in self.request.get("details", ()):
            y = self._text(label, 46, y + 13, self.detail_label, MUTED)
            y = self._wrapped(value, 46, y + 4, 560, self.review_detail)
        content_bottom = y - offset + self.detail_scroll
        self.detail_scroll_limit = max(0, content_bottom + 18 - 474)

    def _review_page_offsets(self) -> tuple[int, int]:
        camera = float(self.review_page)
        if self.review_transition:
            started, source, target = self.review_transition
            progress = min(1.0, (pygame.time.get_ticks() / 1000 - started) / 0.28)
            eased = 1 - (1 - progress) ** 3
            camera = source + (target - source) * eased
            if progress == 1:
                self.review_page = target
                self.review_transition = None
        return round(-camera * 428), round((1 - camera) * 428)

    def _show_review_page(self, page: int) -> None:
        if page == self.review_page or self.review_transition:
            return
        if page == 1:
            self.detail_scroll = 0
        presentation = (self.request or {}).get("presentation") or {}
        animated = self.state == "email_chat" or bool(
            self.request and (self.request.get("facts") or presentation.get("kind") in ("github_pr_v1", "email_reply_v1", "gmail_notification_v1"))
        )
        if self.reduce_motion or not animated:
            self.review_page = page
        else:
            self.review_transition = (pygame.time.get_ticks() / 1000, self.review_page, page)

    def _expired(self) -> bool:
        if not self.request:
            return False
        expires = datetime.fromisoformat(self.request["expires_at"].replace("Z", "+00:00"))
        return expires <= datetime.now(timezone.utc)

    def draw_window(self) -> None:
        surface = self.render()
        self.window.blit(surface, (0, 0))

    def logical_point(self, point: tuple[int, int]) -> tuple[int, int] | None:
        window_width, window_height = self.window_size
        if not (0 <= point[0] < window_width and 0 <= point[1] < window_height):
            return None
        if not self.simulator:
            return point
        return (
            int(point[0] * LOGICAL_SIZE[0] / window_width),
            int(point[1] * LOGICAL_SIZE[1] / window_height),
        )

    def _scroll_by(self, amount: int) -> None:
        self.scroll = min(self.scroll_limit, max(0, self.scroll + amount))

    def _scroll_detail_by(self, amount: int) -> None:
        self.detail_scroll = min(self.detail_scroll_limit, max(0, self.detail_scroll + amount))

    def _finish_swipe(self, point: tuple[int, int]) -> None:
        if self.swipe_start:
            delta_x = point[0] - self.swipe_start[0]
            delta_y = point[1] - self.swipe_start[1]
            horizontal = abs(delta_x) >= 60 and abs(delta_x) > abs(delta_y)
            vertical = abs(delta_y) >= 60 and abs(delta_y) > abs(delta_x)
            on_feed = self.state == "idle" or self.state == "request"
            active_notification = self.state == "email_chat" or self.state == "request" and self.screen == self.notification_screen
            if self.quick_settings and vertical and delta_y > 0:
                self.quick_settings = False
            elif on_feed and not active_notification and vertical and delta_y < 0:
                self.quick_settings = True
            elif on_feed and horizontal and not self.quick_settings:
                if self.screen == "home":
                    self.screen = "right" if delta_x > 0 else "left"
                elif self.screen == "left" and delta_x > 0 or self.screen == "right" and delta_x < 0:
                    self.screen = "home"
            elif active_notification and vertical and self.review_page == 0 and delta_y < 0:
                self._show_review_page(1)
            elif active_notification and vertical and self.review_page == 1 and self.detail_scroll == 0 and delta_y > 0:
                self._show_review_page(0)
        self.swipe_start = None

    def _finish_pointer(self, point: tuple[int, int]) -> None:
        if self.settings_slider:
            start = self.swipe_start
            if start and abs(point[1] - start[1]) >= 60 and abs(point[1] - start[1]) > abs(point[0] - start[0]):
                self.settings_slider = None
                self._finish_swipe(point)
                return
            self._set_slider(point, persist=True)
            self.settings_slider = None
            self.swipe_start = None
            return
        start = self.swipe_start
        tapped_setting = bool(self.quick_settings and start and abs(point[0] - start[0]) < 20 and abs(point[1] - start[1]) < 20)
        self._finish_swipe(point)
        if tapped_setting:
            self._change_quick_setting(point)

    def handle_event(self, event: pygame.event.Event) -> bool:
        self.needs_render = True
        if event.type == pygame.QUIT or event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
            return False
        if event.type in (pygame.KEYDOWN, pygame.MOUSEBUTTONDOWN, pygame.FINGERDOWN):
            self.last_interaction_at = time.monotonic()
        if event.type == pygame.KEYDOWN:
            if event.key == pygame.K_a:
                self.choose("approved")
            elif event.key == pygame.K_r:
                self.choose("rejected")
            elif event.key == pygame.K_o:
                self.toggle_offline()
            elif event.key == pygame.K_v:
                if self.state == "recording":
                    self.stop_recording()
                else:
                    self.start_recording()
            elif event.key == pygame.K_DOWN:
                if self.quick_settings:
                    self.quick_settings = False
                    self.settings_slider = None
                elif self.state == "request" and self.screen == self.notification_screen and self.review_page == 0:
                    self._show_review_page(1)
                elif self.state == "request" and self.screen == self.notification_screen:
                    self._scroll_detail_by(60)
            elif event.key == pygame.K_UP:
                if self.state in ("idle", "request") and not self.quick_settings and not (self.state == "request" and self.screen == self.notification_screen):
                    self.quick_settings = True
                elif self.state == "request" and self.screen == self.notification_screen and self.detail_scroll:
                    self._scroll_detail_by(-60)
                elif self.state == "request" and self.screen == self.notification_screen:
                    self._show_review_page(0)
            elif event.key == pygame.K_LEFT and self.state in ("idle", "request"):
                self.screen = "home" if self.screen == "right" else "left" if self.screen == "home" else self.screen
            elif event.key == pygame.K_RIGHT and self.state in ("idle", "request"):
                self.screen = "home" if self.screen == "left" else "right" if self.screen == "home" else self.screen
        review_request = self.state == "email_chat" or bool(
            self.state == "request" and self.screen == self.notification_screen and self.request
        )
        feed_navigation = self.quick_settings or self.state in ("idle", "request")
        if self.simulator and event.type == pygame.MOUSEBUTTONDOWN:
            point = self.logical_point(event.pos)
            if point is not None:
                self.dragging = True
                self.swipe_start = point if review_request or feed_navigation else None
                row = (point[1] - 96) // 52
                if self.quick_settings and row in (1, 2):
                    self.settings_slider = "brightness" if row == 1 else "volume"
                    self._set_slider(point)
        if event.type == pygame.MOUSEBUTTONUP:
            if (review_request or feed_navigation) and hasattr(event, "pos"):
                point = self.logical_point(event.pos)
                if point is not None:
                    self._finish_pointer(point)
            self.dragging = False
        if event.type == pygame.MOUSEMOTION and self.dragging:
            if self.settings_slider:
                point = self.logical_point(event.pos)
                if point is not None:
                    self._set_slider(point)
            elif review_request and self.review_page == 1 and not self.review_transition:
                self._scroll_detail_by(-event.rel[1])
            elif not review_request and self.state != "idle":
                self._scroll_by(-event.rel[1])
        if event.type == pygame.MOUSEWHEEL:
            if review_request and event.y:
                if self.review_page == 0 and event.y < 0:
                    self._show_review_page(1)
                elif self.review_page == 1:
                    self._scroll_detail_by(-event.y * 40)
            elif not review_request:
                self._scroll_by(-event.y * 36)
        if event.type == pygame.FINGERDOWN and (review_request or feed_navigation):
            self.swipe_start = (round(event.x * 640), round(event.y * 480))
            row = (self.swipe_start[1] - 96) // 52
            if self.quick_settings and row in (1, 2):
                self.settings_slider = "brightness" if row == 1 else "volume"
                self._set_slider(self.swipe_start)
        if event.type == pygame.FINGERUP and (review_request or feed_navigation):
            self._finish_pointer((round(event.x * 640), round(event.y * 480)))
        if event.type == pygame.FINGERMOTION:
            amount = -round(event.dy * LOGICAL_SIZE[1])
            if self.settings_slider:
                self._set_slider((round(event.x * 640), round(event.y * 480)))
            elif review_request and self.review_page == 1 and not self.review_transition:
                self._scroll_detail_by(amount)
            elif not review_request and self.state != "idle":
                self._scroll_by(amount)
        return True

    def run(self) -> None:
        self.start_gpio()
        if not self.demo:
            self.worker.start()
        clock = pygame.time.Clock()
        running = True
        while running:
            if not self.demo:
                self.apply_worker_events()
            if self.state == "request" and self._expired():
                self.state = "expired"
                self.needs_render = True
            if self.result_until and time.monotonic() >= self.result_until:
                self._complete_decision_result()
            for event in pygame.event.get():
                running = self.handle_event(event)
            if self.touch:
                event_types = {"down": pygame.FINGERDOWN, "motion": pygame.FINGERMOTION, "up": pygame.FINGERUP}
                for kind, x, y, dx, dy in self.touch.poll():
                    running = self.handle_event(pygame.event.Event(event_types[kind], x=x, y=y, dx=dx, dy=dy, finger_id=0, touch_id=0))
            animated = self.state in ("idle", "approved", "rejected") or self.mascot_action is not None or self.review_transition is not None
            if self.needs_render or animated:
                self.draw_window()
                if self.framebuffer:
                    self.framebuffer.present(self.window)
                elif self.native_window:
                    self.native_window.flip()
                else:
                    pygame.display.flip()
                self.needs_render = False
            clock.tick(30 if self.dragging or animated else 10)
        if not self.demo:
            self.worker.close()
        self.recorder.cancel()
        for button in self.buttons:
            button.close()
        if self.touch:
            self.touch.close()
        if self.framebuffer:
            self.framebuffer.close()
        pygame.quit()


def main() -> None:
    root = Path(os.getenv("CLOUDY_STATE_DIR", Path.home() / ".local/state/cloudy-pod")).expanduser()
    storage = Storage(root)
    worker = PodWorker(ApiClient(os.getenv("CLOUDY_API_URL", "http://localhost:3001")), storage)
    PodApp(worker, storage, simulator=os.getenv("CLOUDY_SIMULATOR", "1") != "0").run()
