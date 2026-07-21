import fcntl
import os
import struct
from pathlib import Path

import pygame


EV_SYN = 0
EV_KEY = 1
EV_ABS = 3
SYN_REPORT = 0
BTN_TOUCH = 0x14A
ABS_X = 0
ABS_Y = 1
ABS_PRESSURE = 24
INPUT_EVENT = struct.Struct("llHHi")
ABS_INFO = struct.Struct("iiiiii")


def _flag(name: str) -> bool:
    return os.getenv(name) == "1"


class Backlight:
    def __init__(self, path: Path):
        self.brightness_path = path / "brightness"
        maximum_path = path / "max_brightness"
        if not self.brightness_path.is_file() or not os.access(self.brightness_path, os.W_OK):
            raise FileNotFoundError(f"Backlight brightness is not writable: {self.brightness_path}")
        try:
            self.maximum = int(maximum_path.read_text().strip())
        except FileNotFoundError:
            raise FileNotFoundError(f"Backlight maximum is unavailable: {maximum_path}") from None
        except ValueError:
            raise ValueError(f"Backlight maximum is invalid: {maximum_path}") from None
        if self.maximum <= 0:
            raise ValueError(f"Backlight maximum must be positive: {maximum_path}")

    @classmethod
    def from_env(cls) -> "Backlight | None":
        configured = os.getenv("CLOUDY_BACKLIGHT")
        if not configured:
            return None
        if configured != "auto":
            return cls(Path(configured))
        for path in sorted(Path("/sys/class/backlight").glob("*")):
            try:
                return cls(path)
            except (OSError, ValueError):
                continue
        raise FileNotFoundError("A writable Linux backlight was not found")

    def set(self, percent: int) -> None:
        value = self.maximum if percent >= 100 else max(1, round(self.maximum * max(0, percent) / 100))
        self.brightness_path.write_text(str(value))


class FramebufferOutput:
    def __init__(self, path: Path, size: tuple[int, int] | None = None):
        self.path = path
        if size is None:
            width, height = (Path("/sys/class/graphics") / path.name / "virtual_size").read_text().strip().split(",")
            size = int(width), int(height)
        self.size = size
        self.frame = pygame.Surface(size, depth=16, masks=(0xF800, 0x07E0, 0x001F, 0))
        self.device = path.open("r+b", buffering=0)
        self.last_frame: bytes | None = None

    @classmethod
    def from_env(cls) -> "FramebufferOutput | None":
        path = os.getenv("CLOUDY_FRAMEBUFFER")
        if path == "auto":
            for framebuffer in sorted(Path("/sys/class/graphics").glob("fb*")):
                if "ili9341" in (framebuffer / "name").read_text(errors="ignore").lower():
                    path = f"/dev/{framebuffer.name}"
                    break
            else:
                raise FileNotFoundError("ILI9341 framebuffer was not found")
        return cls(Path(path)) if path else None

    def present(self, source: pygame.Surface) -> None:
        self.frame.blit(pygame.transform.scale(source, self.size), (0, 0))
        pixels = bytes(self.frame.get_buffer())
        if pixels == self.last_frame:
            return
        self.device.seek(0)
        self.device.write(pixels)
        self.last_frame = pixels

    def close(self) -> None:
        self.device.close()


class TouchInput:
    def __init__(self, path: Path):
        self.path = path
        self.device = path.open("rb", buffering=0)
        os.set_blocking(self.device.fileno(), False)
        self.x_range = self._axis_range(ABS_X)
        self.y_range = self._axis_range(ABS_Y)
        self.x = self.x_range[0]
        self.y = self.y_range[0]
        self.pressed = False
        self.was_pressed = False
        self.moved = False
        self.last_point = (0.0, 0.0)
        self.swap_xy = _flag("CLOUDY_TOUCH_SWAP_XY")
        self.invert_x = _flag("CLOUDY_TOUCH_INVERT_X")
        self.invert_y = _flag("CLOUDY_TOUCH_INVERT_Y")

    @classmethod
    def from_env(cls) -> "TouchInput | None":
        configured = os.getenv("CLOUDY_TOUCH_DEVICE")
        if not configured:
            return None
        if configured != "auto":
            return cls(Path(configured))
        for event in sorted(Path("/sys/class/input").glob("event*")):
            if "ADS7846" in (event / "device/name").read_text(errors="ignore"):
                return cls(Path("/dev/input") / event.name)
        raise FileNotFoundError("ADS7846-compatible touch input was not found")

    def _axis_range(self, axis: int) -> tuple[int, int]:
        data = bytearray(ABS_INFO.size)
        fcntl.ioctl(self.device.fileno(), 0x80184540 + axis, data)
        _, minimum, maximum, _, _, _ = ABS_INFO.unpack(data)
        return minimum, maximum

    @staticmethod
    def _normalize(value: int, bounds: tuple[int, int], invert: bool) -> float:
        minimum, maximum = bounds
        normalized = min(1.0, max(0.0, (value - minimum) / (maximum - minimum)))
        return 1 - normalized if invert else normalized

    def _point(self) -> tuple[float, float]:
        x = self._normalize(self.x, self.x_range, self.invert_x)
        y = self._normalize(self.y, self.y_range, self.invert_y)
        return (y, x) if self.swap_xy else (x, y)

    def poll(self) -> list[tuple[str, float, float, float, float]]:
        events: list[tuple[str, float, float, float, float]] = []
        while True:
            try:
                data = self.device.read(INPUT_EVENT.size * 64)
            except BlockingIOError:
                break
            if not data:
                break
            for offset in range(0, len(data), INPUT_EVENT.size):
                _, _, kind, code, value = INPUT_EVENT.unpack(data[offset:offset + INPUT_EVENT.size])
                if kind == EV_ABS and code == ABS_X:
                    self.x = value
                    self.moved = True
                elif kind == EV_ABS and code == ABS_Y:
                    self.y = value
                    self.moved = True
                elif kind == EV_ABS and code == ABS_PRESSURE:
                    self.pressed = value > 0
                elif kind == EV_KEY and code == BTN_TOUCH:
                    self.pressed = value > 0
                elif kind == EV_SYN and code == SYN_REPORT:
                    point = self._point()
                    if self.pressed and not self.was_pressed:
                        events.append(("down", *point, 0.0, 0.0))
                    elif self.pressed and self.moved:
                        events.append(("motion", *point, point[0] - self.last_point[0], point[1] - self.last_point[1]))
                    elif not self.pressed and self.was_pressed:
                        events.append(("up", *point, 0.0, 0.0))
                    self.was_pressed = self.pressed
                    self.last_point = point
                    self.moved = False
        return events

    def close(self) -> None:
        self.device.close()
