import queue
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
        self.commands.put({"request": request, "outcome": outcome})

    def close(self) -> None:
        self.stop_event.set()

    def run(self) -> None:
        pairing: dict[str, Any] | None = None
        saved_credentials = self.storage.credentials()
        token = saved_credentials.get("token") if saved_credentials else None
        last_request_id: str | None = None

        while not self.stop_event.is_set():
            if self.offline.is_set():
                self.stop_event.wait(0.2)
                continue
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
                elif command:
                    request = command["request"]
                    outcome = command["outcome"]
                    self.client.decide(
                        token,
                        request["id"],
                        outcome,
                        request["payload_hash"],
                        str(uuid.uuid4()),
                    )
                    self.storage.clear_request()
                    last_request_id = None
                    self.emit("decided", outcome=outcome)
                    self.stop_event.wait(1.5)
                    continue

                current = self.client.current_request(token)
                request = current.get("request")
                if request:
                    self.storage.save_request(request)
                    if request["id"] != last_request_id:
                        self.emit("request", request=request, queue_size=current.get("queue_size", 1))
                    last_request_id = request["id"]
                else:
                    if last_request_id is not None:
                        self.storage.clear_request()
                        self.emit("idle")
                    elif last_request_id is None:
                        self.emit("idle")
                    last_request_id = None
                self.stop_event.wait(self.poll_seconds)
            except ApiError as error:
                if error.status == 0:
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
                    self.emit("error", message=str(error))
                    self.stop_event.wait(self.poll_seconds)
