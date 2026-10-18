"""Create the original OrbitChat Windows icon using only Python's standard library."""
from __future__ import annotations

import math
import os
import struct
import zlib


SIZE = 256
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), "build")


def smooth(edge: float, width: float = 1.0) -> float:
    t = max(0.0, min(1.0, (edge + width / 2) / width))
    return t * t * (3 - 2 * t)


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def pixel(x: float, y: float) -> tuple[int, int, int, int]:
    cx = cy = SIZE / 2
    radius = 48
    qx, qy = abs(x - cx) - (cx - radius), abs(y - cy) - (cy - radius)
    sdf = math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - radius
    alpha = round(255 * smooth(-sdf, 1.5))
    if alpha == 0:
        return (0, 0, 0, 0)

    # Soft violet center glow over a nearly-black plum background.
    glow = max(0.0, 1 - math.hypot(x - 98, y - 77) / 205) ** 2
    color = mix((20, 20, 30), (64, 47, 104), glow * 0.83)

    # A tilted orbital ellipse, plus its subtle halo.
    dx, dy = x - cx, y - cy
    angle = math.radians(24)
    ex = dx * math.cos(angle) + dy * math.sin(angle)
    ey = -dx * math.sin(angle) + dy * math.cos(angle)
    level = math.sqrt((ex / 86) ** 2 + (ey / 55) ** 2)
    ring_distance = abs(level - 1) * 50
    halo = max(0.0, 1 - ring_distance / 13) * 0.13
    color = mix(color, (168, 157, 255), halo)
    ring = 1 - smooth(ring_distance - 4.1, 1.6)
    color = mix(color, (187, 178, 255), ring)

    # Bright central planet with a pale highlight and a small cyan orbiting moon.
    central_dist = math.hypot(dx, dy)
    planet = 1 - smooth(central_dist - 22, 1.6)
    color = mix(color, (198, 188, 255), planet)
    highlight = max(0.0, 1 - math.hypot(x - 120, y - 115) / 31) * planet * 0.42
    color = mix(color, (250, 246, 255), highlight)
    moon_x, moon_y = cx + 60, cy - 45
    moon_dist = math.hypot(x - moon_x, y - moon_y)
    moon_halo = max(0.0, 1 - moon_dist / 17) * 0.4
    color = mix(color, (77, 181, 221), moon_halo)
    moon = 1 - smooth(moon_dist - 8, 1.5)
    color = mix(color, (150, 231, 255), moon)

    return (*color, alpha)


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def write_preview(rgba: list[tuple[int, int, int, int]], path: str) -> None:
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)
        for r, g, b, a in rgba[y * SIZE : (y + 1) * SIZE]:
            raw.extend((r, g, b, a))
    header = struct.pack(">2I5B", SIZE, SIZE, 8, 6, 0, 0, 0)
    payload = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + png_chunk(b"IEND", b"")
    with open(path, "wb") as output:
        output.write(payload)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    rgba = [pixel(x + 0.5, y + 0.5) for y in range(SIZE) for x in range(SIZE)]
    # ICO stores 32-bit BGRA XOR pixels bottom-up, followed by the 1-bit AND mask.
    xor = bytearray()
    for y in range(SIZE - 1, -1, -1):
        for r, g, b, a in rgba[y * SIZE : (y + 1) * SIZE]:
            xor.extend((b, g, r, a))
    mask_stride = ((SIZE + 31) // 32) * 4
    mask = bytes(mask_stride * SIZE)
    dib = struct.pack("<IiiHHIIiiII", 40, SIZE, SIZE * 2, 1, 32, 0, len(xor) + len(mask), 0, 0, 0, 0)
    image = dib + xor + mask
    directory = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(image), 22)
    with open(os.path.join(OUT_DIR, "icon.ico"), "wb") as output:
        output.write(directory + entry + image)
    write_preview(rgba, os.path.join(OUT_DIR, "icon-preview.png"))
    print(f"Created {os.path.join(OUT_DIR, 'icon.ico')}")


if __name__ == "__main__":
    main()
