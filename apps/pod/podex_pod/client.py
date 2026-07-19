import json
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
            raise ApiError(0, "Podex is unreachable") from error

    def start_pairing(self) -> dict[str, Any]:
        return self._request("POST", "/v1/pod/pairing-sessions")

    def pairing_status(self, session_id: str, token: str) -> str:
        return self._request("GET", f"/v1/pod/pairing-sessions/{session_id}", token)["status"]

    def current_request(self, token: str) -> dict[str, Any]:
        return self._request("GET", "/v1/pod/requests/current", token)

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
