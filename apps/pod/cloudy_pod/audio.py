import os
import subprocess
import tempfile
import wave
from pathlib import Path


class Recorder:
    def __init__(self, root: Path, command: str = "arecord", device: str | None = None):
        self.root = root
        self.command = command
        self.device = device
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
            arguments = [self.command]
            if self.device:
                arguments.extend(("-D", self.device))
            self.process = subprocess.Popen(
                [*arguments, "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-d", "30", name]
            )
        except OSError:
            self.path.unlink(missing_ok=True)
            self.path = None
            raise

    def stop(self) -> Path | None:
        if not self.process:
            return None
        return_code = self.process.poll()
        failed = return_code not in (None, 0)
        if return_code is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)
        self.process = None
        path, self.path = self.path, None
        if failed or not path or not self._valid(path):
            if path:
                path.unlink(missing_ok=True)
            raise OSError("Microphone capture failed")
        return path

    @staticmethod
    def _valid(path: Path) -> bool:
        try:
            with wave.open(str(path), "rb") as recording:
                return (
                    recording.getnchannels() == 1
                    and recording.getsampwidth() == 2
                    and recording.getframerate() == 16_000
                    and recording.getnframes() > 0
                    and len(recording.readframes(1)) == 2
                )
        except (EOFError, OSError, wave.Error):
            return False

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
    def __init__(self, on_action, on_record_start, on_record_stop):
        self.on_action = on_action
        self.on_record_start = on_record_start
        self.on_record_stop = on_record_stop
        self.pressed: set[str] = set()
        self.held: set[str] = set()
        self.recording = False
        self.blocked = False

    def press(self, name: str) -> None:
        self.pressed.add(name)
        if len(self.pressed) == 2:
            self.blocked = True

    def hold(self, name: str) -> None:
        if name not in self.pressed:
            return
        self.held.add(name)
        if len(self.held) == 2 and not self.recording:
            self.recording = True
            self.on_record_start()

    def release(self, name: str) -> None:
        was_recording = self.recording
        self.pressed.discard(name)
        self.held.discard(name)
        if was_recording:
            self.recording = False
            self.on_record_stop()
        elif not self.blocked and not self.pressed:
            self.on_action("approved" if name == "approve" else "rejected")
        if not self.pressed:
            self.blocked = False
