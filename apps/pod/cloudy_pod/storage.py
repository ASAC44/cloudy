import json
import os
from pathlib import Path
from typing import Any


class Storage:
    def __init__(self, root: Path):
        self.root = root
        self.credentials_path = root / "credentials.json"
        self.request_path = root / "active-request.json"
        self.settings_path = root / "settings.json"

    def _read(self, path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text())
            return value if isinstance(value, dict) else None
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None

    def _write(self, path: Path, value: dict[str, Any], mode: int = 0o600) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, separators=(",", ":")))
        os.chmod(temporary, mode)
        temporary.replace(path)

    def credentials(self) -> dict[str, Any] | None:
        return self._read(self.credentials_path)

    def save_credentials(self, token: str) -> None:
        self._write(self.credentials_path, {"token": token})

    def clear_credentials(self) -> None:
        self.credentials_path.unlink(missing_ok=True)

    def request(self) -> dict[str, Any] | None:
        return self._read(self.request_path)

    def save_request(self, request: dict[str, Any]) -> None:
        self._write(self.request_path, request)

    def clear_request(self) -> None:
        self.request_path.unlink(missing_ok=True)

    def settings(self) -> dict[str, Any] | None:
        return self._read(self.settings_path)

    def save_settings(self, settings: dict[str, Any]) -> None:
        self._write(self.settings_path, settings)
