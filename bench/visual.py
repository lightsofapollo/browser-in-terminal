#!/usr/bin/env python3
"""
Visual regression test.

Drives the real app through a synthetic terminal, replays the escape stream it emits through a
reference kitty compositor, and diffs the reconstructed screen against the frame Chromium actually
rendered. This is what catches stale tiles, misplaced tiles and z-order mistakes — none of which
are visible when you only assert on the bytes being sent.

On failure it writes composited.png and expected.png so the difference can be looked at.
"""

import os
import pty
import re
import select
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kitty_compositor import Compositor, compare, make_shm_reader, write_png

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PX = (1600, 900)
CELLS = (157, 44)
CELL = (10, 20)
DUMP = "/tmp/et-visual-source.rgba"

# Panel switches that exercise the paths that have broken: full-frame fallback (canvas), scattered
# damage (motion), tiny damage (cursor), and static pages.
SEQUENCE = ["4", "1", "7", "6", "4", "2", "1", "3", "1"]


class Run:
    def __init__(self, extra=""):
        self.extra = extra
        for path in (DUMP, DUMP + ".meta"):
            if os.path.exists(path):
                os.remove(path)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(APP)
            os.environ["TERM"] = "xterm-ghostty"
            os.execv("/bin/sh", ["sh", "-c",
                     "npx electron . --scenario=idle --dump-source=%s %s 2>/tmp/et-visual.log"
                     % (DUMP, extra)])
        self.stream = bytearray()
        self.probe = [0, 0, 0, 0]
        self.shm_pending = b""
        self.shm_cache = {}
        self.reader = make_shm_reader()

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.02)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 1 << 20)
            except OSError:
                return
            self.stream += chunk
            self._drain_shm(chunk)
            recent = bytes(self.stream[-8192:])
            if self.probe[0] < recent.count(b"\x1b[14t"):
                self.probe[0] += 1
                os.write(self.fd, b"\x1b[4;%d;%dt\x1b[8;%d;%dt\x1b[6;%d;%dt"
                         % (PX[1], PX[0], CELLS[1], CELLS[0], CELL[1], CELL[0]))
            if self.probe[1] < len(re.findall(rb"\x1b_Gi=31[^\x1b]*\x1b\\", recent)):
                self.probe[1] += 1
                os.write(self.fd, b"\x1b_Gi=31;OK\x1b\\")
            # answer the shared-memory probe: this harness really can read our objects
            if self.probe[3] < len(re.findall(rb"\x1b_Gi=32[^\x1b]*\x1b\\", recent)):
                self.probe[3] += 1
                os.write(self.fd, b"\x1b_Gi=32;OK\x1b\\")
            if self.probe[2] < recent.count(b"\x1b[c"):
                self.probe[2] += 1
                os.write(self.fd, b"\x1b[?62;22c")

    def _drain_shm(self, chunk):
        """A terminal maps and unlinks each shm object promptly; do the same so the app's
        reclamation policy is exercised against a realistic consumer."""
        self.shm_pending += chunk
        for m in re.finditer(rb"\x1b_Ga=T,t=s,[^;]*;([A-Za-z0-9+/=]+)\x1b\\", self.shm_pending):
            name = __import__("base64").b64decode(m.group(1)).decode("latin1")
            if name not in self.shm_cache:
                data = self.reader(name)
                if data is not None:
                    self.shm_cache[name] = data
        self.shm_pending = self.shm_pending[-65536:]

    def click(self, x, y, button=0):
        os.write(self.fd, ("\x1b[<%d;%d;%dM" % (button, x, y)).encode())
        self.pump(0.2)
        os.write(self.fd, ("\x1b[<%d;%d;%dm" % (button, x, y)).encode())

    def key(self, char):
        os.write(self.fd, ("\x1b[%d;1;%du" % (ord(char), ord(char))).encode())

    def ctrl(self, char):
        os.write(self.fd, ("\x1b[%d;5u" % ord(char)).encode())

    def kill(self):
        try:
            os.kill(self.pid, 9)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


def main():
    run = Run(sys.argv[1] if len(sys.argv) > 1 else "")
    try:
        run.pump(10)
        # Exercise the transitions, ending on a static page so the screen settles.
        for key in SEQUENCE:
            run.key(key)
            run.pump(1.4)
        run.pump(2.5)

        # The context menu is drawn in the page, so it must composite like anything else. Open it
        # and leave it open: the dumped frame will contain it, and so must our reconstruction.
        run.key("6")
        run.pump(1.5)
        run.click(900, 500, button=2)
        run.pump(2.0)
        run.click(300, 800)          # dismiss the menu
        run.pump(1.0)

        # The select shim must open a dropdown in the page. Click the "Choose an option" control.
        run.click(560, 830)
        run.pump(2.0)

        # Ask for ground truth: the next painted frame is written out and NOT transmitted, so the
        # terminal must already be showing it if our stream was correct.
        run.ctrl("p")
        deadline = time.time() + 12
        while time.time() < deadline and not os.path.exists(DUMP + ".meta"):
            run.pump(0.4)
        run.pump(1.0)

        if not os.path.exists(DUMP):
            print("FAIL: the app never wrote a ground-truth frame")
            return 1

        with open(DUMP, "rb") as handle:
            expected = handle.read()
        width, height = PX
        composer = Compositor(width, height, CELL[0], CELL[1],
                              read_shm=lambda name: run.shm_cache.get(name))
        composer.feed(bytes(run.stream))
        actual = composer.render()

        for err in composer.errors[:5]:
            print("compositor: %s" % err)

        bad, box = compare(actual, expected, width, height)
        total = width * height
        pct = bad * 100.0 / total
        print("placements live: %d   images held: %d" % (len(composer.placements), len(composer.images)))
        print("mismatched pixels: %d of %d (%.3f%%)" % (bad, total, pct))
        if box:
            print("worst region: x %d..%d, y %d..%d" % (box[0], box[2], box[1], box[3]))

        # A little drift is expected: the page can paint between the last transmitted frame and the
        # dump. Whole stale panels are not a little drift.
        if pct > 1.0:
            write_png("/tmp/composited.png", actual, width, height)
            write_png("/tmp/expected.png", expected, width, height)
            print("FAIL: wrote /tmp/composited.png and /tmp/expected.png")
            return 1
        print("PASS: the composited screen matches what Chromium rendered")
        return 0
    finally:
        run.kill()


if __name__ == "__main__":
    sys.exit(main())
