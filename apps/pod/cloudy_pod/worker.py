import queue
import os
import random
import threading
import uuid
from typing import Any

from .client import ApiClient, ApiError
from .storage import Storage


class PodWorker(threading.Thread):
    def __init__(
        self,
        client: ApiClient,
        storage: Storage,
        poll_seconds: float = 10,
        safety_poll_seconds: float = 90,
        pairing_seconds: float = 2,
    ):
        super().__init__(daemon=True)
        self.client = client
        self.storage = storage
        self.poll_seconds = poll_seconds
        self.safety_poll_seconds = safety_poll_seconds
        self.pairing_seconds = pairing_seconds
        self.events: queue.SimpleQueue[dict[str, Any]] = queue.SimpleQueue()
        self.commands: queue.SimpleQueue[dict[str, Any]] = queue.SimpleQueue()
        self.stop_event = threading.Event()
        self.offline = threading.Event()
        self.wake_event = threading.Event()
        self.refresh_pending = threading.Event()
        self.realtime_connected = threading.Event()
        self.listener_stop: threading.Event | None = None
        self.listener_thread: threading.Thread | None = None
        self.event_token: str | None = None

    def emit(self, event: str, **values: Any) -> None:
        self.events.put({"event": event, **values})

    def set_offline(self, offline: bool) -> None:
        if offline:
            self.offline.set()
            self._stop_listener()
            self.emit("offline")
        else:
            self.offline.clear()
            self._request_refresh(force=True)
            self.emit("reconnecting")
        self.wake_event.set()

    def decide(self, request: dict[str, Any], outcome: str) -> None:
        self.commands.put({"request": request, "outcome": outcome, "idempotency_key": str(uuid.uuid4())})
        self.wake_event.set()

    def transcribe(self, path: str) -> None:
        self.commands.put({"transcribe": path})
        self.wake_event.set()

    def prompt(self, prompt: str, target_revision: int, replace_request: dict[str, Any] | None = None) -> None:
        self.commands.put({"prompt": prompt, "target_revision": target_revision, "replace_request": replace_request, "idempotency_key": str(uuid.uuid4()), "decision_idempotency_key": str(uuid.uuid4()) if replace_request else None})
        self.wake_event.set()

    def close(self) -> None:
        self.stop_event.set()
        self._stop_listener()
        self.wake_event.set()

    def _request_refresh(self, force: bool = False) -> None:
        if force or not self.refresh_pending.is_set():
            self.refresh_pending.set()
            self.commands.put({"refresh": True, "force": force})
        self.wake_event.set()

    def _start_listener(self, token: str) -> None:
        if self.event_token == token and self.listener_thread and self.listener_thread.is_alive():
            return
        self._stop_listener()
        stop = threading.Event()
        self.listener_stop = stop
        self.event_token = token
        self.listener_thread = threading.Thread(target=self._listen_events, args=(token, stop), daemon=True)
        self.listener_thread.start()

    def _stop_listener(self) -> None:
        if self.listener_stop:
            self.listener_stop.set()
        self.listener_stop = None
        self.listener_thread = None
        self.event_token = None
        self.realtime_connected.clear()

    def _listen_events(self, token: str, stop: threading.Event) -> None:
        pod_events = getattr(self.client, "pod_events", None)
        if pod_events is None:
            return
        delay = 1.0
        while not self.stop_event.is_set() and not stop.is_set():
            try:
                for event in pod_events(token):
                    if self.stop_event.is_set() or stop.is_set():
                        return
                    self.realtime_connected.set()
                    delay = 1.0
                    if event == "revoked":
                        self.commands.put({"revoked": True})
                        self.wake_event.set()
                        return
                    if event in ("sync", "invalidate"):
                        self._request_refresh()
                self.realtime_connected.clear()
            except ApiError as error:
                self.realtime_connected.clear()
                if error.status == 401:
                    self.commands.put({"revoked": True})
                    self.wake_event.set()
                    return
            self.wake_event.set()
            if stop.wait(delay * random.uniform(0.8, 1.2)):
                return
            delay = min(delay * 2, 30)

    def _wait(self, seconds: float) -> None:
        self.wake_event.wait(seconds)
        self.wake_event.clear()

    def run(self) -> None:
        pairing: dict[str, Any] | None = None
        saved_credentials = self.storage.credentials()
        token = saved_credentials.get("token") if saved_credentials else None
        last_request_id: str | None = None
        idle_emitted = False
        last_codex = repr({})
        last_screen_layout = repr(None)

        while not self.stop_event.is_set():
            if self.offline.is_set():
                self._wait(0.2)
                continue
            command: dict[str, Any] | None = None
            try:
                if not token:
                    if pairing is None:
                        pairing = self.client.start_pairing()
                        self.emit("pairing", **pairing)
                    status = self.client.pairing_status(pairing["session_id"], pairing["pod_token"])
                    if status == "paired":
                        token = pairing["pod_token"]
                        self.storage.save_credentials(token)
                        pairing = None
                        self.emit("paired")
                    elif status == "revoked":
                        pairing = None
                    self._wait(self.pairing_seconds)
                    continue

                self._start_listener(token)

                try:
                    command = self.commands.get_nowait()
                except queue.Empty:
                    command = None
                if command and command.get("refresh"):
                    self.refresh_pending.clear()
                    if command.get("force"):
                        last_request_id = None
                        idle_emitted = False
                elif command and command.get("revoked"):
                    raise ApiError(401, "Unauthorized")
                elif command and command.get("transcribe"):
                    path = command["transcribe"]
                    try:
                        result = self.client.transcribe(token, path)
                        self.emit("transcript", transcript=result["transcript"])
                    finally:
                        try:
                            os.unlink(path)
                        except FileNotFoundError:
                            pass
                    continue
                elif command and command.get("prompt"):
                    self.client.prompt(token, command["prompt"], command["target_revision"], command["idempotency_key"], command.get("replace_request"), command.get("decision_idempotency_key"))
                    if command.get("replace_request"):
                        self.storage.clear_request()
                        last_request_id = None
                    self.emit("prompt_queued")
                    continue
                elif command:
                    request = command["request"]
                    outcome = command["outcome"]
                    self.client.decide(
                        token,
                        request["id"],
                        outcome,
                        request["payload_hash"],
                        command["idempotency_key"],
                    )
                    self.storage.clear_request()
                    last_request_id = None
                    self.emit("decided", outcome=outcome)
                    self._wait(1.5)
                    continue

                current = self.client.current_request(token)
                screen_layout = current.get("screen_layout")
                serialized_layout = repr(screen_layout)
                if screen_layout and serialized_layout != last_screen_layout:
                    self.emit("screen_layout", screen_layout=screen_layout)
                    last_screen_layout = serialized_layout
                codex = current.get("codex") or {}
                serialized_codex = repr(codex)
                if serialized_codex != last_codex:
                    self.emit("codex", codex=codex)
                    last_codex = serialized_codex
                mascot_action = current.get("mascot_action")
                if mascot_action in ("blink", "yawn", "sleep", "jump"):
                    self.emit("mascot_action", action=mascot_action)
                screen_navigation = current.get("screen_navigation")
                directions = [screen_navigation] if isinstance(screen_navigation, str) else screen_navigation or []
                for direction in directions:
                    if direction in ("left", "right", "up", "down", "scroll_up", "scroll_down"):
                        self.emit("screen_navigation", direction=direction)
                decision_animation = current.get("decision_animation")
                if decision_animation in ("approved", "rejected"):
                    self.emit("decided", outcome=decision_animation)
                request = current.get("request")
                if request:
                    self.storage.save_request(request)
                    if request["id"] != last_request_id:
                        self.emit(
                            "request",
                            request=request,
                            queue_size=current.get("queue_size", 1),
                            request_screen=current.get("request_screen", "down"),
                        )
                    last_request_id = request["id"]
                    idle_emitted = False
                else:
                    self.storage.clear_request()
                    if decision_animation in ("approved", "rejected"):
                        last_request_id = None
                        idle_emitted = True
                    elif last_request_id is not None:
                        self.emit("idle")
                    elif not idle_emitted:
                        self.emit("idle")
                    idle_emitted = True
                    last_request_id = None
                self._wait(self.safety_poll_seconds if self.realtime_connected.is_set() else self.poll_seconds)
            except ApiError as error:
                if error.status == 0:
                    last_request_id = None
                    idle_emitted = False
                    if command and not command.get("refresh") and not command.get("transcribe"):
                        self.commands.put(command)
                    self.emit("offline")
                    self._wait(self.poll_seconds)
                elif error.status == 401 and token:
                    self._stop_listener()
                    self.storage.clear_credentials()
                    self.storage.clear_request()
                    token = None
                    pairing = None
                    last_request_id = None
                    self.emit("revoked")
                    self._wait(1.5)
                elif error.status == 404 and pairing:
                    pairing = None
                else:
                    if error.status >= 500 and command and not command.get("refresh") and not command.get("transcribe"):
                        self.commands.put(command)
                    self.emit("error", message=str(error))
                    self._wait(self.poll_seconds)
