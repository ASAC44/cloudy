import math
import os
import queue
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pygame

from .client import ApiClient
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


def idle_pose(elapsed_seconds: float) -> tuple[int, int, bool]:
    """Return the idle mascot's vertical offset, size, and blink state."""
    float_offset = round(3 * math.sin(elapsed_seconds * math.tau / 5))
    size = 184 + 4 * round(math.sin(elapsed_seconds * math.tau / 3.6))
    blink_phase = elapsed_seconds % 4.2
    return float_offset, size, 3.75 <= blink_phase < 3.9


def pixel_mascot(blinking: bool) -> pygame.Surface:
    size = 48
    mask = pygame.Surface((size, size), pygame.SRCALPHA)
    pygame.draw.rect(mask, pygame.Color("white"), (10, 12, 29, 27))
    for center, radius in (((15, 13), 8), ((24, 10), 10), ((34, 14), 9), ((40, 23), 8), ((38, 33), 9), ((29, 39), 10), ((18, 38), 9), ((10, 30), 9), ((8, 20), 8)):
        pygame.draw.circle(mask, pygame.Color("white"), center, radius)

    mascot = pygame.Surface((size, size), pygame.SRCALPHA)
    for y in range(size):
        color = MASCOT_TOP.lerp(MASCOT_BOTTOM, y / (size - 1))
        pygame.draw.line(mascot, color, (0, y), (size, y))
    mascot.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MULT)

    eye_height = 2 if blinking else 11
    eye_y = 25 if blinking else 20
    pygame.draw.rect(mascot, BACKGROUND, (17, eye_y, 5, eye_height), border_radius=2)
    pygame.draw.rect(mascot, BACKGROUND, (29, eye_y, 5, eye_height), border_radius=2)
    return mascot


def wrap(font: pygame.font.Font, value: str, width: int) -> list[str]:
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
    return lines


class PodApp:
    def __init__(self, worker: PodWorker, storage: Storage, simulator: bool = True):
        pygame.init()
        self.worker = worker
        self.storage = storage
        self.simulator = simulator
        self.surface = pygame.Surface(LOGICAL_SIZE)
        self.window = pygame.display.set_mode(
            SIMULATOR_SIZE if simulator else LOGICAL_SIZE,
            pygame.NOFRAME if simulator else pygame.FULLSCREEN,
        )
        pygame.display.set_caption("Podex · Virtual Pod")
        self.font = pygame.font.Font(None, 27)
        self.small = pygame.font.Font(None, 22)
        self.heading = pygame.font.Font(None, 48)
        self.code_font = pygame.font.Font(None, 64)
        self.state = "offline" if storage.request() else "startup"
        self.request = storage.request()
        self.queue_size = 0
        self.pairing_code = ""
        self.message = "Starting Pod…"
        self.scroll = 0
        self.dragging = False
        self.offline = False
        self.result_until = 0.0
        self.buttons: list[Any] = []
        self.wrap_cache: dict[tuple[int, str, int], list[str]] = {}
        self.idle_mascots = (pixel_mascot(False), pixel_mascot(True))

    def start_gpio(self) -> None:
        if self.simulator:
            return
        from gpiozero import Button

        approve = Button(int(os.getenv("PODEX_APPROVE_PIN", "5")), pull_up=True, bounce_time=0.05)
        reject = Button(int(os.getenv("PODEX_REJECT_PIN", "6")), pull_up=True, bounce_time=0.05)
        approve.when_pressed = lambda: self.choose("approved")
        reject.when_pressed = lambda: self.choose("rejected")
        self.buttons = [approve, reject]

    def choose(self, outcome: str) -> None:
        if self.state != "request" or self.offline or not self.request:
            return
        if self._expired():
            self.state = "expired"
            return
        self.state = "submitting"
        self.message = "Approving…" if outcome == "approved" else "Rejecting…"
        self.worker.decide(self.request, outcome)

    def toggle_offline(self) -> None:
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
            kind = event["event"]
            if kind == "pairing":
                self.pairing_code = event["pairing_code"]
                self.state = "pairing"
            elif kind in ("paired", "idle"):
                self.state = "idle"
                self.request = None
            elif kind == "request":
                self.request = event["request"]
                self.wrap_cache.clear()
                self.queue_size = event["queue_size"]
                self.scroll = 0
                self.state = "request"
            elif kind == "decided":
                self.state = event["outcome"]
                self.result_until = time.monotonic() + 1.3
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

    def _text(self, value: str, x: int, y: int, font: pygame.font.Font | None = None, color: pygame.Color = INK) -> int:
        selected = font or self.font
        image = selected.render(value, True, color)
        self.surface.blit(image, (x, y))
        return y + selected.get_linesize()

    def _wrapped(self, value: str, x: int, y: int, width: int, font: pygame.font.Font | None = None, color: pygame.Color = INK) -> int:
        selected = font or self.font
        key = (id(selected), value, width)
        lines = self.wrap_cache.setdefault(key, wrap(selected, value, width))
        for line in lines:
            y = self._text(line, x, y, selected, color)
        return y

    def _status(self, label: str, color: pygame.Color) -> None:
        pygame.draw.circle(self.surface, color, (32, 27), 5)
        self._text(label.upper(), 46, 15, self.small, MUTED)
        pygame.draw.line(self.surface, DIVIDER, (24, 50), (616, 50))

    def render(self) -> pygame.Surface:
        self.surface.fill(BACKGROUND)
        if self.state == "pairing":
            self._status("Ready to pair", AMBER)
            self._text("Pair your Pod", 36, 130, self.heading)
            self._wrapped("Enter the code shown here in the Podex dashboard.", 36, 188, 270, self.font, MUTED)
            code_image = self.code_font.render(self.pairing_code, True, INK)
            self.surface.blit(code_image, code_image.get_rect(center=(480, 190)))
            self._wrapped("Expires after 10 minutes.", 386, 245, 200, self.small, MUTED)
        elif self.state == "idle":
            self._render_idle()
        elif self.state in ("approved", "rejected"):
            accepted = self.state == "approved"
            self._status("Decision saved", GREEN if accepted else CLAY)
            self._text("Approved" if accepted else "Rejected", 36, 188, self.heading, GREEN if accepted else CLAY)
            self._wrapped("This was a test Ping. No external action was executed.", 38, 246, 560, self.font, MUTED)
        elif self.state == "revoked":
            self._status("Unpaired", CLAY)
            self._text("Pod access revoked", 36, 188, self.heading)
            self._wrapped("Returning to pairing…", 38, 246, 560, self.font, MUTED)
        elif self.state == "startup":
            label = self.heading.render("Starting", True, INK)
            self.surface.blit(label, label.get_rect(center=(320, 218)))
            active_dot = pygame.time.get_ticks() // 350 % 3
            for index, x in enumerate((300, 320, 340)):
                pygame.draw.circle(self.surface, INK if index == active_dot else DIVIDER, (x, 264), 4)
        elif self.state in ("submitting", "error"):
            self._status("Error" if self.state == "error" else "Working", CLAY if self.state == "error" else AMBER)
            self._text(self.message, 36, 188, self.heading if len(self.message) < 22 else self.font)
            if self.state == "error":
                self._wrapped("Pod will retry automatically.", 38, 246, 560, self.font, MUTED)
        else:
            self._render_request(self.state == "offline")
        return self.surface

    def _render_idle(self) -> None:
        float_offset, size, blinking = idle_pose(pygame.time.get_ticks() / 1000)
        center_x, center_y = 320, 190 + float_offset
        mascot = pygame.transform.scale(self.idle_mascots[blinking], (size, size))
        self.surface.blit(mascot, mascot.get_rect(center=(center_x, center_y)))

        label = self.heading.render("All caught up", True, INK)
        self.surface.blit(label, label.get_rect(center=(320, 350)))

    def _render_request(self, offline: bool) -> None:
        if not self.request:
            self._status("Offline" if offline else "Waiting", CLAY if offline else AMBER)
            self._text("No cached Ping", 36, 188, self.heading)
            self._wrapped("Reconnect to check the approval queue.", 38, 246, 560, self.font, MUTED)
            return

        expired = self._expired()
        label = "Expired" if expired else "Offline · read only" if offline else f"Ping 1 of {max(self.queue_size, 1)}"
        self._status(label, CLAY if offline or expired else AMBER)
        self.surface.set_clip(pygame.Rect(0, 52, 640, 428))
        y = 70 - self.scroll
        y = self._wrapped(self.request["title"], 28, y, 584, self.heading)
        y = self._wrapped(self.request["source"], 30, y + 6, 580, self.small, MUTED)
        risk = self.request["risk"].upper()
        badge = self.small.render(f"{risk} RISK", True, BACKGROUND)
        badge_width = badge.get_width() + 26
        pygame.draw.rect(
            self.surface,
            CLAY if risk == "HIGH" else AMBER,
            (30, y + 18, badge_width, 28),
            border_radius=14,
        )
        self.surface.blit(badge, (43, y + 23))
        y += 72
        y = self._wrapped(self.request["summary"], 30, y, 580)
        for heading, value in (
            ("DETAILS", self.request.get("details", "")),
            ("AFFECTED", self.request.get("affected_context", "")),
            ("WARNINGS", "\n".join(self.request.get("warnings", []))),
        ):
            if value:
                y = self._text(heading, 30, y + 28, self.small, MUTED)
                y = self._wrapped(value, 30, y + 8, 580, self.font)
        y = self._text("TEST PING", 30, y + 28, self.small, MUTED)
        self._wrapped("A decision is recorded, but no external action runs.", 30, y + 8, 580, self.small, MUTED)
        self.surface.set_clip(None)

        if offline or expired:
            pygame.draw.rect(self.surface, BACKGROUND, (0, 418, 640, 62))
            pygame.draw.line(self.surface, DIVIDER, (24, 418), (616, 418))
            self._wrapped("Reconnect before deciding." if offline else "This Ping can no longer be decided.", 30, 436, 580, self.small, CLAY)

    def _expired(self) -> bool:
        if not self.request:
            return False
        expires = datetime.fromisoformat(self.request["expires_at"].replace("Z", "+00:00"))
        return expires <= datetime.now(timezone.utc)

    def draw_window(self) -> None:
        surface = self.render()
        self.window.blit(
            pygame.transform.smoothscale(surface, self.window.get_size()) if self.simulator else surface,
            (0, 0),
        )

    def logical_point(self, point: tuple[int, int]) -> tuple[int, int] | None:
        window_width, window_height = self.window.get_size()
        if not (0 <= point[0] < window_width and 0 <= point[1] < window_height):
            return None
        if not self.simulator:
            return point
        return (
            int(point[0] * LOGICAL_SIZE[0] / window_width),
            int(point[1] * LOGICAL_SIZE[1] / window_height),
        )

    def handle_event(self, event: pygame.event.Event) -> bool:
        if event.type == pygame.QUIT or event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
            return False
        if event.type == pygame.KEYDOWN:
            if event.key == pygame.K_a:
                self.choose("approved")
            elif event.key == pygame.K_r:
                self.choose("rejected")
            elif event.key == pygame.K_o:
                self.toggle_offline()
        if self.simulator and event.type == pygame.MOUSEBUTTONDOWN:
            if self.logical_point(event.pos) is not None:
                self.dragging = True
        if event.type == pygame.MOUSEBUTTONUP:
            self.dragging = False
        if event.type == pygame.MOUSEMOTION and self.dragging:
            self.scroll = min(4000, max(0, self.scroll - event.rel[1]))
        if event.type == pygame.FINGERMOTION:
            self.scroll = min(4000, max(0, self.scroll - round(event.dy * LOGICAL_SIZE[1])))
        return True

    def run(self) -> None:
        self.start_gpio()
        self.worker.start()
        clock = pygame.time.Clock()
        running = True
        while running:
            self.apply_worker_events()
            if self.state == "request" and self._expired():
                self.state = "expired"
            if self.result_until and time.monotonic() >= self.result_until:
                self.result_until = 0
                self.state = "startup"
                self.message = "Checking for Pings…"
            for event in pygame.event.get():
                running = self.handle_event(event)
            self.draw_window()
            pygame.display.flip()
            clock.tick(30 if self.dragging or self.state in ("idle", "startup", "submitting") else 10)
        self.worker.close()
        for button in self.buttons:
            button.close()
        pygame.quit()


def main() -> None:
    root = Path(os.getenv("PODEX_STATE_DIR", Path.home() / ".local/state/podex-pod")).expanduser()
    storage = Storage(root)
    worker = PodWorker(ApiClient(os.getenv("PODEX_API_URL", "http://localhost:3001")), storage)
    PodApp(worker, storage, simulator=os.getenv("PODEX_SIMULATOR", "1") != "0").run()
