#!/usr/bin/env python3
"""
Benchmark harness for browser-in-terminal.

Runs the app under a synthetic terminal that answers the capability probe exactly as kitty and
ghostty do, then collects the metrics JSON the app emits and prints a comparison table.

IMPORTANT about what this measures. The synthetic terminal drains stdout immediately and does no
image decoding, so these numbers are the APPLICATION cost: Chromium paint -> pixel conversion ->
protocol encoding -> write(). They deliberately exclude the terminal's own decode, texture upload
and present. That half is real and is measured separately by running inside a real terminal:

    npm start -- --metrics=/tmp/m.jsonl --duration=30 --scenario=canvas

Use this harness for regression detection and A/B of transports; use a real terminal for the
end-to-end number a user actually feels.
"""

import argparse
import json
import os
import pty
import re
import select
import subprocess
import sys
import time

# What a kitty-graphics-capable terminal replies to our probe.
GEOMETRY_RE = re.compile(rb"\x1b\[14t")
GRAPHICS_RE = re.compile(rb"\x1b_Gi=31[^\x1b]*\x1b\\")
SHM_RE = re.compile(rb"\x1b_Gi=32[^\x1b]*\x1b\\")
DA1_RE = re.compile(rb"\x1b\[c")


def run_case(app_dir, args, px, cells, timeout):
    """Run one configuration under a pty; return the final metrics dict, or None."""
    metrics_path = "/tmp/et-bench-%d.jsonl" % os.getpid()
    if os.path.exists(metrics_path):
        os.remove(metrics_path)

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(app_dir)
        os.environ["TERM"] = "xterm-ghostty"
        cmd = "npx electron . %s --metrics=%s 2>/dev/null" % (" ".join(args), metrics_path)
        os.execv("/bin/sh", ["sh", "-c", cmd])

    seen = b""
    answered_geometry = False
    answered_graphics = False
    answered_shm = False
    answered_da1 = False
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if not ready:
                if not is_alive(pid):
                    break
                continue
            try:
                chunk = os.read(fd, 1 << 20)
            except OSError:
                break
            if not chunk:
                break
            seen += chunk

            # Reply as a supporting terminal would, in the order a real one would.
            if not answered_geometry and GEOMETRY_RE.search(seen):
                answered_geometry = True
                # CSI 14 t (window px), CSI 18 t (grid), CSI 16 t (cell px). The cell size is
                # deliberately not a divisor of the window, as on a real terminal.
                os.write(fd, b"\x1b[4;%d;%dt\x1b[8;%d;%dt\x1b[6;20;10t"
                         % (px[1], px[0], cells[1], cells[0]))
            if not answered_graphics and GRAPHICS_RE.search(seen):
                answered_graphics = True
                os.write(fd, b"\x1b_Gi=31;OK\x1b\\")
            # this harness can read our shared memory, so answer the probe affirmatively;
            # without this the app correctly falls back to the inline path and the benchmark
            # would silently measure the wrong transport
            if not answered_shm and SHM_RE.search(seen):
                answered_shm = True
                os.write(fd, b"\x1b_Gi=32;OK\x1b\\")
            if not answered_da1 and DA1_RE.search(seen):
                answered_da1 = True
                os.write(fd, b"\x1b[?62;22c")
            seen = seen[-4096:]  # the probe is answered; stop retaining the frame stream
    finally:
        if is_alive(pid):
            os.kill(pid, 9)
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        os.close(fd)

    return read_final(metrics_path)


def is_alive(pid):
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
        return done == 0
    except ChildProcessError:
        return False


def read_final(path):
    if not os.path.exists(path):
        return None
    best = None
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                sample = json.loads(line)
            except json.JSONDecodeError:
                continue
            if sample.get("final"):
                return sample
            best = sample  # fall back to the last periodic sample if the run was killed
    return best


SWEEP = [
    ("tile 4x2",  ["--tile-cols=4", "--tile-rows=2"]),
    ("tile 6x3",  ["--tile-cols=6", "--tile-rows=3"]),
    ("tile 10x5", ["--tile-cols=10", "--tile-rows=5"]),
    ("tile 16x8", ["--tile-cols=16", "--tile-rows=8"]),
    ("tile 24x12",["--tile-cols=24", "--tile-rows=12"]),
]

CASES = [
    # label,               extra args
    ("idle/damage",        ["--scenario=idle"]),
    ("tiny/damage",        ["--scenario=cursor"]),
    ("scroll/damage",      ["--scenario=motion"]),
    ("canvas/damage",      ["--scenario=canvas"]),
    ("canvas/texture",     ["--scenario=canvas", "--texture"]),
    ("canvas/full-b64",    ["--scenario=canvas", "--mode=0"]),
    ("typography/damage",  ["--scenario=text"]),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=float, default=12.0, help="seconds per case")
    parser.add_argument("--warmup", type=float, default=3.0, help="seconds discarded per case")
    parser.add_argument("--px", default="1600x900", help="synthetic window size in device pixels")
    # Deliberately fractional cells (1600/157 = 10.19, 900/44 = 20.45). Whole-number cells hide a
    # whole class of placement bug, because tile pixel origins then coincide with cell origins
    # by accident.
    parser.add_argument("--cells", default="157x44", help="synthetic grid size in cells")
    parser.add_argument("--json", default=None, help="write the full report here")
    parser.add_argument("--only", default=None, help="substring filter on case labels")
    parser.add_argument("--sweep", default=None, help="sweep tile sizes against this scenario")
    parser.add_argument("--compare", default=None, help="compare against a saved report and flag regressions")
    parser.add_argument("--tolerance", type=float, default=40.0, help="percent timing regression allowed")
    parser.add_argument("--repeat", type=int, default=1, help="runs per case; the median is reported")
    options = parser.parse_args()

    px = tuple(int(v) for v in options.px.split("x"))
    cells = tuple(int(v) for v in options.cells.split("x"))
    app_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    results = []
    if options.sweep:
        cases = [(label, ["--scenario=%s" % options.sweep] + extra) for label, extra in SWEEP]
    else:
        cases = [c for c in CASES if not options.only or options.only in c[0]]
    for label, extra in cases:
        sys.stderr.write("running %-20s " % label)
        sys.stderr.flush()
        args = extra + ["--duration=%g" % options.duration, "--warmup=%g" % options.warmup]
        started = time.time()
        runs = []
        for _ in range(max(1, options.repeat)):
            final = run_case(app_dir, args, px, cells, options.duration + 25)
            if final is not None:
                runs.append(final)
        if not runs:
            sys.stderr.write("FAILED (no metrics)\n")
            results.append({"label": label, "error": "no metrics produced"})
            continue
        # Report the median run by frame p50: timing on a loaded machine is noisy enough that a
        # single run cannot distinguish a regression from a neighbouring process.
        runs.sort(key=lambda r: r["timings"]["frame"]["p50"])
        chosen = runs[len(runs) // 2]
        chosen["runs"] = len(runs)
        sys.stderr.write("%.0fs (%d run%s)\n" % (time.time() - started, len(runs), "" if len(runs) == 1 else "s"))
        chosen["label"] = label
        results.append(chosen)

    report(results, px)
    if options.compare:
        if compare(results, options.compare, options.tolerance):
            sys.exit(1)
    if options.json:
        with open(options.json, "w") as handle:
            json.dump({"px": list(px), "cells": list(cells), "results": results}, handle, indent=2)
        sys.stderr.write("\nfull report: %s\n" % options.json)


def compare(results, baseline_path, tolerance):
    """Print per-case deltas against a saved report. Returns True if anything regressed."""
    try:
        with open(baseline_path) as handle:
            baseline = {r["label"]: r for r in json.load(handle)["results"] if "label" in r}
    except (OSError, ValueError) as err:
        sys.stderr.write("cannot read baseline %s: %s\n" % (baseline_path, err))
        return False

    print("\nregression check against %s (timing tolerance %.0f%%)" % (baseline_path, tolerance))
    print("compared on frame p50 and bytes/frame: p95 varies by more than 80% run-to-run on a")
    print("loaded machine, so it reports the tail but cannot decide a regression.")
    print("%-20s %-22s %-22s" % ("case", "frame p50 (ms)", "bytes/frame (KB)"))
    print("-" * 66)
    regressed = False
    for current in results:
        label = current.get("label")
        before = baseline.get(label)
        if not before or "error" in current or "error" in before:
            continue
        rows = []
        for name, now, was in (
            ("frame p50", current["timings"]["frame"]["p50"], before["timings"]["frame"]["p50"]),
            ("bytes", current["bytes"]["perFrame"]["p50"] / 1024.0, before["bytes"]["perFrame"]["p50"] / 1024.0),
        ):
            if was <= 0.001:
                rows.append("%8.2f -> %8.2f      " % (was, now))
                continue
            delta = (now - was) / was * 100.0
            flag = ""
            # Sub-millisecond and sub-kilobyte moves are noise, not regressions.
            # bytes are deterministic, so a small threshold is meaningful; timing needs headroom
            significant = (name == "frame p50" and now > 1.0) or (name == "bytes" and now > 32)
            if name == "bytes" and abs(delta) > 5:
                flag = "  BYTES CHANGED" if delta > 0 else "  bytes improved"
                if delta > 5:
                    regressed = True
            if delta > tolerance and significant:
                flag = "  REGRESSED"
                regressed = True
            elif delta < -tolerance:
                flag = "  improved"
            rows.append("%8.2f -> %8.2f %+6.0f%%%s" % (was, now, delta, flag))
        print("%-20s %s %s" % (label, rows[0], rows[1]))
    print("\n%s" % ("REGRESSIONS DETECTED" if regressed else "no regressions"))
    return regressed


def report(results, px):
    header = ("case", "fps", "frame p50", "p95", "p99", "max", "gap p95", "KB/frame", "MB/s", "tiles", "drop", "rss")
    rows = []
    for r in results:
        if "error" in r:
            rows.append((r["label"], "-", r["error"], "", "", "", "", "", "", "", "", ""))
            continue
        t = r["timings"]
        rows.append((
            r["label"],
            "%.1f" % r["fps"],
            "%.2f" % t["frame"]["p50"],
            "%.2f" % t["frame"]["p95"],
            "%.2f" % t["frame"]["p99"],
            "%.2f" % t["frame"]["max"],
            "%.1f" % t["interval"]["p95"],
            "%.0f" % (r["bytes"]["perFrame"]["p50"] / 1024.0),
            "%.1f" % r["bytes"]["rateMiBs"],
            "%.0f" % r["tiles"]["p50"],
            str(r["counters"].get("dropped", 0)),
            "%.0f" % r["memory"]["rssMiB"],
        ))
    widths = [max(len(str(row[i])) for row in ([header] + rows)) for i in range(len(header))]
    line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(header))
    print("\nbrowser-in-terminal benchmark — application cost only (synthetic terminal, %dx%d)" % px)
    print(line)
    print("-" * len(line))
    for row in rows:
        print("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(row)))
    print("\nfps is frames delivered to the terminal; gap p95 is the 95th-percentile interval")
    print("between presented frames. Terminal-side decode and present are NOT included.")


if __name__ == "__main__":
    main()
