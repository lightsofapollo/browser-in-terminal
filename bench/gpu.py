#!/usr/bin/env python3
"""Sample macOS GPU utilization (no sudo needed) and the busiest processes alongside it."""
import re, subprocess, sys, time

UTIL = re.compile(rb'"Device Utilization %"=(\d+)')


def gpu():
    out = subprocess.run(["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"],
                         capture_output=True).stdout
    vals = [int(m.group(1)) for m in UTIL.finditer(out)]
    return max(vals) if vals else -1


def top_procs(n=6):
    out = subprocess.run(["ps", "-Ao", "pcpu,comm"], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines()[1:]:
        parts = line.strip().split(None, 1)
        if len(parts) == 2:
            try:
                rows.append((float(parts[0]), parts[1].split("/")[-1]))
            except ValueError:
                pass
    rows.sort(reverse=True)
    return rows[:n]


def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 10
    label = sys.argv[2] if len(sys.argv) > 2 else "sample"
    samples = []
    end = time.time() + seconds
    while time.time() < end:
        samples.append(gpu())
        time.sleep(0.5)
    samples = [s for s in samples if s >= 0]
    if not samples:
        print("could not read GPU utilization")
        return
    samples.sort()
    print("%-22s GPU util: min %d  median %d  max %d  (n=%d)"
          % (label, samples[0], samples[len(samples) // 2], samples[-1], len(samples)))
    print("   busiest: " + ", ".join("%s %.0f%%" % (name, cpu) for cpu, name in top_procs()))


if __name__ == "__main__":
    main()
