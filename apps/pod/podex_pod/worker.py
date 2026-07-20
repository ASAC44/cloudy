import queue
import os
import threading
import time
import uuid
from typing import Any

from .client import ApiClient, ApiError
from .storage import Storage


class PodWorker(threading.Thread):
    def __init__(self, client: ApiClient, storage: Storage, poll_seconds: float = 2):
        super().__init__(daemon=True)
        self.client = client
        self.storage = storage
        self.poll_seconds = poll_seconds
        self.events: queue.SimpleQueue[dict[str, Any]] = queue.SimpleQueue()
        self.commands: queue.SimpleQueue[dict[str, Any]] = queue.SimpleQueue()
        self.stop_event = threading.Event()
        self.offline = threading.Event()

    def emit(self, event: str, **values: Any) -> None:
        self.events.put({"event": event, **values})

    def set_offline(self, offline: bool) -> None:
        if offline:
            self.offline.set()
            self.emit("offline")
        else:
            self.offline.clear()
            self.commands.put({"refresh": True})
            self.emit("reconnecting")

    def decide(self, request: dict[str, Any], outcome: str) -> None:
        self.commands.put({"request": request, "outcome": outcome, "idempotency_key": str(uuid.uuid4())})

    def transcribe(self, path: str) -> None:
        self.commands.put({"transcribe": path})

    def prompt(self, prompt: str, target_revision: int, replace_request: dict[str, Any] | None = None) -> None:
        self.commands.put({"prompt": prompt, "target_revision": target_revision, "replace_request": replace_request, "idempotency_key": str(uuid.uuid4()), "decision_idempotency_key": str(uuid.uuid4()) if replace_request else None})

    def close(self) -> None:
        self.stop_event.set()

    def run(self) -> None:
        pairing: dict[str, Any] | None = None
        saved_credentials = self.storage.credentials()
        token = saved_credentials.get("token") if saved_credentials else None
        last_request_id: tuple[str, str] | None = None
        idle_emitted = False
        last_codex = repr({})
        last_screen_layout = repr(None)

        while not self.stop_event.is_set():
            if self.offline.is_set():
                self.stop_event.wait(0.2)
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
                    self.stop_event.wait(self.poll_seconds)
                    continue

                try:
                    command = self.commands.get_nowait()
                except queue.Empty:
                    command = None
                if command and command.get("refresh"):
                    last_request_id = None
                    idle_emitted = False
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
                    self.stop_event.wait(1.5)
                    continue

                current = self.client.current_request(token)
                screen_layout = current.get("screen_layout")
                screen_items = current.get("screen_items", [])
                serialized_layout = repr((screen_layout, screen_items))
                if screen_layout and serialized_layout != last_screen_layout:
                    self.emit("screen_layout", screen_layout=screen_layout, screen_items=screen_items)
                    last_screen_layout = serialized_layout
                codex = current.get("codex") or {}
                serialized_codex = repr(codex)
                if serialized_codex != last_codex:
                    self.emit("codex", codex=codex)
                    last_codex = serialized_codex
                request = current.get("request")
                if request:
                    self.storage.save_request(request)
                    request_revision = (request["id"], request["payload_hash"])
                    if request_revision != last_request_id:
                        self.emit(
                            "request",
                            request=request,
                            queue_size=current.get("queue_size", 1),
                            request_screen=current.get("request_screen", "down"),
                        )
                    last_request_id = request_revision
                    idle_emitted = False
                else:
                    if last_request_id is not None:
                        self.storage.clear_request()
                        self.emit("idle")
                    elif not idle_emitted:
                        self.emit("idle")
                    idle_emitted = True
                    last_request_id = None
                self.stop_event.wait(self.poll_seconds)
            except ApiError as error:
                if error.status == 0:
                    last_request_id = None
                    idle_emitted = False
                    if command and not command.get("refresh") and not command.get("transcribe"):
                        self.commands.put(command)
                    self.emit("offline")
                    self.stop_event.wait(self.poll_seconds)
                elif error.status == 401 and token:
                    self.storage.clear_credentials()
                    self.storage.clear_request()
                    token = None
                    pairing = None
                    last_request_id = None
                    self.emit("revoked")
                    self.stop_event.wait(1.5)
                elif error.status == 404 and pairing:
                    pairing = None
                else:
                    if error.status >= 500 and command and not command.get("refresh") and not command.get("transcribe"):
                        self.commands.put(command)
                    self.emit("error", message=str(error))
                    self.stop_event.wait(self.poll_seconds)
