import os
import subprocess
import tempfile
from pathlib import Path


class Recorder:
    def __init__(self, root: Path, command: str = "arecord"):
        self.root = root
        self.command = command
        self.process: subprocess.Popen[bytes] | None = None
        self.path: Path | None = None

    def start(self) -> None:
        if self.process:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix="voice-", suffix=".wav", dir=self.root)
        os.close(descriptor)
        os.chmod(name, 0o600)
        self.path = Path(name)
        try:
            self.process = subprocess.Popen(
                [self.command, "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-d", "30", name]
            )
        except OSError:
            self.path.unlink(missing_ok=True)
            self.path = None
            raise

    def stop(self) -> Path | None:
        if not self.process:
            return None
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)
        self.process = None
        return self.path

    def cancel(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self.process = None
        if self.path:
            self.path.unlink(missing_ok=True)
            self.path = None


class ButtonChord:
    def __init__(self, on_action, on_record_start, on_record_stop, window: float = 0.25, clock=None):
        import time
        self.on_action = on_action
        self.on_record_start = on_record_start
        self.on_record_stop = on_record_stop
        self.window = window
        self.clock = clock or time.monotonic
        self.pressed: set[str] = set()
        self.first_at = 0.0
        self.recording = False
        self.blocked = False

    def press(self, name: str) -> None:
        if not self.pressed:
            self.first_at = self.clock()
        self.pressed.add(name)
        if len(self.pressed) == 2:
            if self.clock() - self.first_at <= self.window:
                self.recording = True
                self.on_record_start()
            else:
                self.blocked = True

    def release(self, name: str) -> None:
        was_recording = self.recording
        self.pressed.discard(name)
        if was_recording:
            self.recording = False
            self.blocked = bool(self.pressed)
            self.on_record_stop()
        elif not self.blocked and not self.pressed:
            self.on_action("approved" if name == "approve" else "rejected")
        if not self.pressed:
            self.blocked = False
