import json
import uuid
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class ApiClient:
    def __init__(self, base_url: str, timeout: float = 5):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        token: str | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        data = None
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        request = Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read() or b"{}")
        except HTTPError as error:
            try:
                message = json.loads(error.read()).get("error", "API request failed")
            except (json.JSONDecodeError, AttributeError):
                message = "API request failed"
            raise ApiError(error.code, message) from error
        except (URLError, TimeoutError, OSError) as error:
            raise ApiError(0, "Cloudy is unreachable") from error

    def start_pairing(self) -> dict[str, Any]:
        return self._request("POST", "/v1/pod/pairing-sessions")

    def pairing_status(self, session_id: str, token: str) -> str:
        return self._request("GET", f"/v1/pod/pairing-sessions/{session_id}", token)["status"]

    def current_request(self, token: str) -> dict[str, Any]:
        return self._request("GET", "/v1/pod/requests/current", token)

    def pod_events(self, token: str):
        request = Request(
            f"{self.base_url}/v1/pod/events",
            headers={"Accept": "text/event-stream", "Authorization": f"Bearer {token}"},
            method="GET",
        )
        try:
            with urlopen(request, timeout=35) as response:
                event = None
                for raw_line in response:
                    line = raw_line.decode("utf-8").rstrip("\r\n")
                    if line.startswith(":"):
                        continue
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif not line and event:
                        yield event
                        event = None
        except HTTPError as error:
            try:
                message = json.loads(error.read()).get("error", "Pod events unavailable")
            except (json.JSONDecodeError, AttributeError):
                message = "Pod events unavailable"
            raise ApiError(error.code, message) from error
        except (URLError, TimeoutError, OSError) as error:
            raise ApiError(0, "Cloudy is unreachable") from error

    def decide(
        self,
        token: str,
        request_id: str,
        outcome: str,
        payload_hash: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/pod/requests/{request_id}/decision",
            token,
            {
                "outcome": outcome,
                "payload_hash": payload_hash,
                "idempotency_key": idempotency_key,
            },
        )

    def transcribe(self, token: str, path: str) -> dict[str, Any]:
        boundary = f"----cloudy{uuid.uuid4().hex}"
        with open(path, "rb") as recording:
            audio = recording.read()
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"cloudy.wav\"\r\n"
            "Content-Type: audio/wav\r\n\r\n"
        ).encode() + audio + f"\r\n--{boundary}--\r\n".encode()
        request = Request(
            f"{self.base_url}/v1/pod/codex/transcriptions",
            data=body,
            headers={"Accept": "application/json", "Authorization": f"Bearer {token}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=35) as response:
                return json.loads(response.read() or b"{}")
        except HTTPError as error:
            try:
                message = json.loads(error.read()).get("error", "Transcription failed")
            except (json.JSONDecodeError, AttributeError):
                message = "Transcription failed"
            raise ApiError(error.code, message) from error
        except (URLError, TimeoutError, OSError) as error:
            raise ApiError(0, "Cloudy is unreachable") from error

    def prompt(self, token: str, prompt: str, target_revision: int, idempotency_key: str, replace_request: dict[str, Any] | None = None, decision_idempotency_key: str | None = None) -> dict[str, Any]:
        body = {
            "prompt": prompt,
            "target_revision": target_revision,
            "idempotency_key": idempotency_key,
        }
        if replace_request:
            body.update({
                "replace_request_id": replace_request["id"],
                "replace_payload_hash": replace_request["payload_hash"],
                "decision_idempotency_key": decision_idempotency_key,
            })
        return self._request("POST", "/v1/pod/codex/prompts", token, body)
