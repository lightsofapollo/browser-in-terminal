#!/usr/bin/env python3
"""
A reference kitty-graphics compositor.

Decodes the escape stream we emit and reconstructs the screen a conforming terminal would show.
This is the only way to test what a user actually sees: asserting on the bytes we send cannot
catch a stale placement, a tile drawn beside the pixels it came from, or an image compositing in
the wrong order — and every one of those has shipped in this project.

Implements the subset we emit:
  CSI row;col H          cursor position (a placement lands at the cursor)
  APC a=T ... ; payload  transmit and display, f=24 or f=32, o=z, direct or shared memory
  APC a=d,d=I,i=N        delete image N and its placements
  APC a=d,d=A            delete everything
  CSI ?2026 h/l          synchronized output (frame brackets; no effect on final content)

Compositing order is the protocol's: by z, then by image id, then by placement order — which is
exactly the rule that made stale tiles float above a correct full frame.
"""

import base64
import os
import re
import zlib

APC = re.compile(rb"\x1b_G([^;\x1b]*);?([^\x1b]*)\x1b\\", re.S)
CURSOR = re.compile(rb"\x1b\[(\d+);(\d+)H")
CURSOR_HOME = re.compile(rb"\x1b\[H")


def parse_keys(blob):
    keys = {}
    for part in blob.decode("latin1").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            keys[k] = v
    return keys


class Compositor:
    def __init__(self, width, height, cell_width, cell_height, read_shm=None):
        self.width = width
        self.height = height
        self.cell_width = cell_width
        self.cell_height = cell_height
        self.read_shm = read_shm
        self.images = {}       # id -> (w, h, rgba bytes)
        self.placements = []   # (z, id, seq, col, row)
        self.seq = 0
        self.cursor = (0, 0)   # col, row
        self.pending = None    # chunked transmit in progress: (keys, [chunks])
        self.errors = []

    def feed(self, data):
        """Replay a byte stream, applying cursor moves and graphics commands in order."""
        pos = 0
        while pos < len(data):
            apc = APC.search(data, pos)
            head = data[pos:apc.start()] if apc else data[pos:]
            self._apply_cursor(head)
            if not apc:
                break
            self._graphics(parse_keys(apc.group(1)), apc.group(2))
            pos = apc.end()

    def _apply_cursor(self, chunk):
        last_col = last_row = None
        for m in re.finditer(rb"\x1b\[(?:(\d+);(\d+))?H", chunk):
            if m.group(1) is None:
                last_col, last_row = 0, 0
            else:
                last_row = int(m.group(1)) - 1
                last_col = int(m.group(2)) - 1
        if last_col is not None:
            self.cursor = (last_col, last_row)

    def _graphics(self, keys, payload):
        action = keys.get("a", "t")

        if action == "d":
            what = keys.get("d", "a")
            if what in ("A", "a"):
                self.images.clear()
                self.placements.clear()
            elif what in ("I", "i"):
                target = int(keys.get("i", "-1"))
                self.images.pop(target, None)
                self.placements = [p for p in self.placements if p[1] != target]
            return

        if action not in ("T", "t", "p"):
            return

        # chunked transmission: m=1 means more follows
        if self.pending is not None:
            self.pending[1].append(payload)
            if keys.get("m", "0") == "1":
                return
            keys, chunks = self.pending[0], self.pending[1]
            self.pending = None
            payload = b"".join(chunks)
        elif keys.get("m", "0") == "1":
            self.pending = (keys, [payload])
            return

        image_id = int(keys.get("i", "0"))
        width = int(keys.get("s", "0"))
        height = int(keys.get("v", "0"))
        fmt = keys.get("f", "32")
        medium = keys.get("t", "d")

        if medium == "s":
            name = base64.b64decode(payload).decode("latin1")
            raw = self.read_shm(name) if self.read_shm else None
            if raw is None:
                self.errors.append("could not read shared memory object %s" % name)
                return
        else:
            raw = base64.b64decode(payload)
            if keys.get("o") == "z":
                raw = zlib.decompress(raw)

        expected = width * height * 4
        # A POSIX shared-memory object is rounded up to a page boundary, so fstat reports more
        # bytes than the image holds. Trust the declared dimensions.
        if medium == "s":
            raw = raw[:expected if fmt == "32" else width * height * 3]
        rgba = raw if fmt == "32" else rgb_to_rgba(raw)
        if len(rgba) != expected:
            self.errors.append("image %d: %d bytes for %dx%d (expected %d)"
                               % (image_id, len(rgba), width, height, expected))
            return

        self.images[image_id] = (width, height, rgba)
        z = int(keys.get("z", "0"))
        col, row = self.cursor
        self.placements = [p for p in self.placements if p[1] != image_id]
        self.placements.append((z, image_id, self.seq, col, row))
        self.seq += 1

    def render(self):
        """Composite to RGBA, in the protocol's order: z, then image id, then placement order."""
        canvas = bytearray(self.width * self.height * 4)
        for z, image_id, _seq, col, row in sorted(self.placements):
            entry = self.images.get(image_id)
            if not entry:
                continue
            iw, ih, pixels = entry
            x0 = col * self.cell_width
            y0 = row * self.cell_height
            for y in range(ih):
                dy = y0 + y
                if dy < 0 or dy >= self.height:
                    continue
                src = y * iw * 4
                dst = (dy * self.width + x0) * 4
                span = min(iw, self.width - x0) * 4
                if span <= 0:
                    continue
                canvas[dst:dst + span] = pixels[src:src + span]
        return bytes(canvas)


def make_shm_reader():
    """Read POSIX shared memory objects by name, the way a terminal does for kitty t=s."""
    import ctypes
    import mmap
    libc = ctypes.CDLL(None, use_errno=True)
    libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_uint]
    libc.shm_open.restype = ctypes.c_int

    def read(name):
        fd = libc.shm_open(name.encode(), os.O_RDONLY, 0)
        if fd < 0:
            return None
        try:
            size = os.fstat(fd).st_size
            if size == 0:
                return None
            with mmap.mmap(fd, size, mmap.MAP_SHARED, mmap.PROT_READ) as region:
                data = region.read(size)
            # A conforming terminal unlinks the object once it has read it.
            libc.shm_unlink(name.encode())
            return data
        finally:
            os.close(fd)

    return read


def rgb_to_rgba(rgb):
    out = bytearray(len(rgb) // 3 * 4)
    for i in range(len(rgb) // 3):
        out[i * 4] = rgb[i * 3]
        out[i * 4 + 1] = rgb[i * 3 + 1]
        out[i * 4 + 2] = rgb[i * 3 + 2]
        out[i * 4 + 3] = 255
    return bytes(out)


def compare(actual, expected, width, height, tolerance=8):
    """Return (mismatched_pixels, bounding_box) ignoring alpha and small colour drift."""
    bad = 0
    minx = miny = 10 ** 9
    maxx = maxy = -1
    for i in range(0, min(len(actual), len(expected)), 4):
        if (abs(actual[i] - expected[i]) > tolerance
                or abs(actual[i + 1] - expected[i + 1]) > tolerance
                or abs(actual[i + 2] - expected[i + 2]) > tolerance):
            bad += 1
            px = (i // 4) % width
            py = (i // 4) // width
            minx = min(minx, px); maxx = max(maxx, px)
            miny = min(miny, py); maxy = max(maxy, py)
    box = None if maxx < 0 else (minx, miny, maxx, maxy)
    return bad, box


def write_png(path, rgba, width, height):
    """Minimal PNG writer so a failure can be looked at."""
    import struct
    raw = b"".join(b"\x00" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
                + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))
