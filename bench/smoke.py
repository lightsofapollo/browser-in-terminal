#!/usr/bin/env python3
"""
End-to-end smoke test: drives the real app through a synthetic kitty-graphics terminal and asserts
the behaviours that have broken before. Exits non-zero on failure, so it can gate a release.
"""

import os
import pty
import re
import select
import signal
import sys
import time

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HUD = re.compile(rb"\x1b\[\d+;1H\x1b\[2K\x1b\[38;5;245m(.*?)\x1b\[0m", re.S)

# Fractional cells on purpose: 1600/157 = 10.19 px, 900/44 = 20.45 px. Whole-number cells make
# tile pixel origins line up with cell origins by accident and hide placement bugs.
# A cell size that does not divide the window, exactly like a real terminal keeping padding:
# 157 cols x 10 px = 1570 of 1600, 44 rows x 20 px = 880 of 900.
state = {"px": (1600, 900), "cells": (157, 44), "cell_px": (10, 20)}


class Term:
    """A synthetic terminal that answers the capability probe like kitty/ghostty."""

    def __init__(self, args="", shm_ok=True):
        self.shm_ok = shm_ok
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(APP)
            os.environ["TERM"] = "xterm-ghostty"
            os.execv("/bin/sh", ["sh", "-c", "npx electron . %s 2>/tmp/et-smoke.log" % args])
        self.buf = b""
        self.geom_served = 0
        self.gfx_served = 0
        self.shm_served = 0
        self.da1_served = 0

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
            self.buf += chunk
            if self.buf.count(b"\x1b[14t") > self.geom_served:
                self.geom_served += 1
                px, cells = state["px"], state["cells"]
                cell = state["cell_px"]
                os.write(self.fd, b"\x1b[4;%d;%dt\x1b[8;%d;%dt\x1b[6;%d;%dt"
                         % (px[1], px[0], cells[1], cells[0], cell[1], cell[0]))
            if len(re.findall(rb"\x1b_Gi=31[^\x1b]*\x1b\\", self.buf)) > self.gfx_served:
                self.gfx_served += 1
                os.write(self.fd, b"\x1b_Gi=31;OK\x1b\\")
            # the shared-memory probe: answer OK only if this "terminal" can read our memory
            if len(re.findall(rb"\x1b_Gi=32[^\x1b]*\x1b\\", self.buf)) > self.shm_served:
                self.shm_served += 1
                os.write(self.fd, b"\x1b_Gi=32;OK\x1b\\" if self.shm_ok
                         else b"\x1b_Gi=32;ENOENT:could not open\x1b\\")
            if self.buf.count(b"\x1b[c") > self.da1_served:
                self.da1_served += 1
                os.write(self.fd, b"\x1b[?62;22c")

    def send(self, data):
        os.write(self.fd, data)

    def ctrl(self, char):
        os.write(self.fd, ("\x1b[%d;5u" % ord(char)).encode())

    def frames(self):
        return self.buf.count(b"\x1b_Ga=T")

    def hud(self):
        found = HUD.findall(self.buf)
        return found[-1].decode("latin1") if found else ""

    def alive(self):
        try:
            done, _ = os.waitpid(self.pid, os.WNOHANG)
            return done == 0
        except ChildProcessError:
            return False

    def kill(self):
        # Bounded teardown: a blocking waitpid here once hung the whole suite after every check
        # had already passed, which reads as a failure when nothing failed.
        try:
            os.kill(self.pid, 9)
        except (ProcessLookupError, ChildProcessError):
            pass
        deadline = time.time() + 3
        while time.time() < deadline:
            try:
                done, _ = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                break
            if done:
                break
            time.sleep(0.05)
        try:
            os.close(self.fd)
        except OSError:
            pass


failures = []


def check(name, condition, detail=""):
    status = "ok  " if condition else "FAIL"
    print("%s %s%s" % (status, name, ("  — " + detail) if detail and not condition else ""))
    if not condition:
        failures.append(name)


def main():
    # Run 1: a static page must cost nothing, and the protocol flags must be right.
    t = Term("--scenario=idle")
    try:
        t.pump(8)
        check("starts and renders", t.frames() > 0, "no image transmits")
        check("uses the atomic frame wrapper", b"\x1b[?2026h" in t.buf)
        check("suppresses protocol replies (q=2)", b"q=2" in t.buf)
        check("places below text (z=-1)", b"z=-1" in t.buf)
        check("never moves the cursor (C=1)", b"C=1" in t.buf)
        before = t.frames()
        t.pump(4)
        idle = t.frames() - before
        check("idle page sends no frames", idle == 0, "sent %d frames while idle" % idle)
        t.send(b"\x1b[113;5u")  # ctrl+q
        t.pump(3)
        check("exits on ctrl+q", not t.alive())
        tail = t.buf[-4000:]
        check("restores the alt screen", b"\x1b[?1049l" in tail)
        check("disables mouse reporting", b"\x1b[?1016l" in tail)
        check("restores autowrap", b"\x1b[?7h" in tail)
        check("deletes its images", b"a=d,d=A" in tail)
    finally:
        t.kill()

    # Run 2: an animating page, so "is it still rendering?" is a meaningful question.
    t = Term("--scenario=cursor")
    try:
        t.pump(8)
        t.send(b"\x1b[104;5u")  # ctrl+h once: compact -> full breakdown
        t.pump(1)
        for i in range(25):
            t.send(b"\x1b[<35;%d;%dM" % (500 + i * 8, 350))
        t.pump(2)
        hud = t.hud()
        events = re.search(r"in (\d+)", hud)
        check("input events are parsed", bool(events) and int(events.group(1)) >= 25, hud[:110])
        check("no undelivered input", "undeliv 0" in hud, hud[:110])
        check("no input errors", re.search(r"err 0", hud) is not None, hud[:110])
        check("damage tracking is engaged", not re.search(r"tiles 0 ", hud), hud[:110])

        # Regression: at equal z the higher image id wins, so tile placements (ids 2+) used to
        # float on top of a full frame (id 1). A full frame must retire them first.
        full_frames = [m.start() for m in re.finditer(rb"a=T,t=s,f=32,s=\d+,v=\d+,i=1,", t.buf)]
        retired_before_full = 0
        for pos in full_frames:
            window = t.buf[max(0, pos - 4000):pos]
            if b"a=d,d=I,i=" in window:
                retired_before_full += 1
        check("full frames retire stale tile placements",
              not full_frames or retired_before_full > 0,
              "%d full frames, %d preceded by deletes" % (len(full_frames), retired_before_full))

        # The retire must cover the WHOLE tile id range, not only the tiles we think we placed:
        # bookkeeping is exactly what is lost across a window swap or an unhonoured delete.
        if full_frames:
            window = t.buf[max(0, full_frames[-1] - 8000):full_frames[-1]]
            ids = set(int(m.group(1)) for m in re.finditer(rb"a=d,d=I,i=(\d+)", window))
            check("retire covers a contiguous id range from 2",
                  len(ids) >= 8 and 2 in ids and max(ids) - min(ids) + 1 == len(ids),
                  "ids=%s" % sorted(ids)[:8])

        before = t.frames()
        t.send(b"\x1b[51;5u")  # ctrl+3 -> inline base64 transport
        t.pump(4)
        check("transport switch keeps rendering", t.frames() > before)

        before = t.frames()
        t.send(b"\x1b[116;5u")  # ctrl+t -> window swap (used to strand input)
        t.pump(5)
        for i in range(10):
            t.send(b"\x1b[<35;%d;%dM" % (600 + i * 5, 400))
        t.pump(2)
        check("window swap keeps rendering", t.frames() > before)
        check("window swap keeps input alive", "undeliv 0" in t.hud(), t.hud()[:110])

        # DevTools is hosted in a second offscreen window and composited into its own slice of
        # the terminal. It must use a distinct image id range, or the two surfaces draw over each
        # other (at equal z the higher id wins).
        before = len(t.buf)
        t.ctrl("i")
        t.pump(7)
        after = t.buf[before:]
        ids = set(int(m.group(1)) for m in re.finditer(rb"a=T,t=s,[^;]*i=(\d+),", after))
        page_ids = [i for i in ids if i < 4096]
        dev_ids = [i for i in ids if i >= 4096]
        check("ctrl+i renders devtools in its own id range", len(dev_ids) > 3,
              "page=%d devtools=%d" % (len(page_ids), len(dev_ids)))
        columns = sorted(set(int(m.group(2)) for m in re.finditer(rb"\x1b\[(\d+);(\d+)H", after)))
        check("devtools is placed beside the page, not over it",
              bool(columns) and columns[-1] > 80, "columns %s..%s" % (columns[:1], columns[-1:]))

        before = len(t.buf)
        t.ctrl("i")
        t.pump(5)
        closed = t.buf[before:]
        closed_dev = [i for i in set(int(m.group(1)) for m in re.finditer(rb"a=T,t=s,[^;]*i=(\d+),", closed)) if i >= 4096]
        check("closing devtools stops its surface", len(closed_dev) == 0,
              "still transmitting %d devtools images" % len(closed_dev))
        check("page still renders after closing devtools", t.frames() > 0)

        # Chromium logs from C++ straight to fd 2. One line lands inside an image and corrupts
        # the display, and overriding process.stderr in JS cannot stop it.
        leaked = re.findall(rb"\[\d+:\d{4}/\d{6}\.\d+:[A-Z]+:", t.buf)
        check("chromium logging never reaches the screen", not leaked,
              "%d log lines on the tty" % len(leaked))

        # The status line owns its row; a surface drawn under it fights with the text.
        rows = [int(m.group(1)) for m in re.finditer(rb"\x1b\[(\d+);\d+H\x1b_Ga=T", t.buf)]
        check("nothing is placed on the status line row",
              not rows or max(rows) < state["cells"][1],
              "max placement row %s of %d" % (max(rows) if rows else 0, state["cells"][1]))

        # An odd pixel size used to freeze rendering permanently.
        state["px"] = (1601, 901)
        state["cells"] = (157, 44)
        before = t.frames()
        os.kill(t.pid, signal.SIGWINCH)
        t.pump(6)
        check("odd-size resize keeps rendering", t.frames() > before,
              "no frames after resize to %dx%d" % state["px"])
        check("still no input errors after resize", re.search(r"err 0", t.hud()) is not None, t.hud()[:110])
    finally:
        t.kill()

    # A terminal that cannot read our shared memory (any remote session) must fall back to the
    # inline compressed transport rather than silently drawing nothing.
    t = Term("--scenario=cursor", shm_ok=False)
    try:
        t.pump(9)
        t.send(b"\x1b[104;5u")  # ctrl+h -> full breakdown
        t.pump(1.5)
        hud = t.hud()
        check("falls back to the inline transport when shm is unreadable",
              "fallback from shm" in hud, hud[:120])
        check("still renders after the fallback", t.frames() > 0)
    finally:
        t.kill()

    print()
    if failures:
        print("FAILED: %s" % ", ".join(failures))
        return 1
    print("all smoke checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
