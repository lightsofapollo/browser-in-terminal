# browser-in-terminal: performance methodology and results

Measured 2026-08-27, Apple silicon, Electron 44, Ghostty. Reproduce with `npm run bench`.

## What is measured, and what is not

The pipeline has two halves and they must not be conflated:

```
[ application ]                                   [ terminal ]
Chromium paint → dirty rect → tile hash → BGRA→RGBA → shm/base64 → write() ┊ decode → upload → present
└──────────────── measured by bench/bench.py ─────────────────────────────┘ └── measured only in a real terminal ──┘
```

`bench/bench.py` runs the app under a **synthetic terminal**: a pty that answers the capability
probe exactly as kitty and ghostty do, then drains stdout immediately without decoding anything.
That isolates application cost and makes runs repeatable, but it deliberately excludes the
terminal's own work — which is *not* small (Ghostty's kitty-graphics decode is unprofiled upstream,
and measured here at ~14.5 MB/s for the inline path).

For the number a user actually feels, run inside a real terminal:

```
npm start -- --metrics=/tmp/m.jsonl --duration=30 --scenario=canvas
```

Every 1 s and once at exit, a JSON line lands in that file with full percentiles.

**Why percentiles.** A last-frame readout hides the tail, and the tail is what people feel. Every
timing below is a bounded-memory histogram reporting p50/p95/p99/max, plus `gap p95` — the 95th
percentile *interval between presented frames*, which is the honest measure of smoothness.

## Baseline (1600x900 device px, 60 fps cap, median of 3 runs)

| case | fps | frame p50 | p95 | p99 | max | gap p95 | KB/frame | MB/s | tiles |
|---|---|---|---|---|---|---|---|---|---|
| idle | 0.0 | 0.00 | 0.00 | 0.00 | 0.00 | – | **0** | **0.0** | 0 |
| tiny updates | 59.8 | **0.10** | 0.16 | 0.28 | 0.85 | 17.4 | **156** | 10.4 | 4 |
| scroll / motion | 60.0 | 0.64 | 0.80 | 2.17 | 9.59 | 17.7 | 2344 | 136.0 | 60 |
| canvas particles | 60.0 | 0.61 | 0.74 | 1.92 | 7.37 | 19.2 | 2148 | 126.6 | 55 |
| canvas, shared texture | 60.0 | 0.66 | 0.76 | 1.05 | 15.44 | 19.0 | 2188 | 126.6 | 56 |
| canvas, inline base64 | 60.0 | 14.17 | 15.28 | 16.06 | 38.93 | 18.4 | 484 | 28.4 | 1 |
| typography | 0.0 | 0.00 | 0.00 | 0.00 | 0.00 | – | 0 | 0.0 | 0 |

A static page costs **exactly nothing** — no frames, no bytes. That is the property that decides
whether this is usable over SSH or merely a local demo.

## The findings that produced those numbers

### 1. Chromium reports one dirty rect: the union of all damage

This is the single most important fact about the pipeline, and it is easy to miss because a page
with *one* moving element reports beautifully tight rects (48x48 for a pulsing dot).

Measured on the demo's "tiny updates" panel — a clock, a log line and a caret in three different
places — Chromium reports **1174x660**, nearly the whole panel. Naive tiling then falls back to
full frames on almost every paint.

The fix is to treat Chromium's rect as a *search hint*, not as damage: hash each tile inside it
(FNV-1a over 32-bit pixels, in the native addon) and transmit only tiles whose content actually
differs from what was last sent.

| | KB/frame | frame p50 |
|---|---|---|
| union rect only | 5625 (full frame) | 0.63 ms |
| **+ per-tile hashing** | **156** | **0.10 ms** |

**36x fewer bytes.** One subtlety cost an hour: a full-frame upload must *re-hash* every tile, not
zero the hashes. Zeroing makes every tile look changed on the next frame, forcing another full
frame — a feedback loop that silently defeats the whole mechanism.

### 2. `useSharedTexture` disables Chromium's damage reporting — but tile hashing restores it

**Superseded in part.** The measurement below is still true of *Chromium's* dirty rect. It stopped
being the whole story once tiles were hashed: because damage is now computed from pixel content
rather than taken from Chromium, the shared-texture path gets real damage too. The visual test
confirms it — a `--texture` run composites from 21 tile placements, not one full frame per frame.

Identical configuration, only the flag differing:

| `offscreen.useSharedTexture` | paints | full-frame paints |
|---|---|---|
| `false` | 357 | **1** |
| `true` | 357 | **357** |

With shared textures, both `dirtyRect` and `textureInfo.contentRect` are always the whole frame.
Avoiding a GPU readback is worth far less than not sending 5.6 MB, so the CPU bitmap path is the
default. `--texture` remains for content that genuinely changes every pixel every frame.

### 3. Never set `--disable-frame-rate-limit`

| configuration | paints in 6 s | full-frame paints |
|---|---|---|
| default | 714 | 3 (0.4%) |
| `--disable-frame-rate-limit` | 5321 | 5302 (99.6%) |

It also emits ~890 paints/sec. It destroys damage tracking outright.

### 4. Tile size is a transport-dependent trade-off

Scattered small damage ("tiny updates"):

| tile (cells) | KB/frame | tiles | frame p50 |
|---|---|---|---|
| 4x2 | **81** | 13 | 0.17 |
| 6x3 | 112 | 8 | 0.13 |
| 10x5 | 156 | 4 | **0.10** |
| 16x8 | 500 | 5 | 0.13 |
| 24x12 | 450 | 2 | 0.13 |

Dense damage (canvas particles):

| tile (cells) | KB/frame | tiles | frame p50 |
|---|---|---|---|
| 4x2 | 1775 | 284 | 1.69 |
| 6x3 | 1927 | 137 | 0.94 |
| 10x5 | **2148** | 55 | **0.61** |
| 16x8 | 5625 (collapses) | 1 | 2.22 |

Smaller tiles track damage more finely (fewer bytes) but cost more per-tile work and more escapes.
Which side is scarce depends on the transport, so the default follows it: **10x5 for shared memory**
(CPU-bound) and **4x2 for the inline path** (byte-bound). Override with `--tile-cols/--tile-rows`.

### 5a. Alpha is dead weight

An opaque page has a constant alpha channel, so `f=24` (3-byte RGB) removes a quarter of every
byte — both what we write into shared memory and what the terminal has to upload as a texture.
Packing costs a little CPU because the writes stop being 4-byte aligned:

| canvas particles, shared memory | bytes/frame | frame p50 |
|---|---|---|
| `f=32` RGBA | 2148 KB | 0.61 ms |
| **`f=24` RGB** | **1611 KB (-25%)** | 0.66 ms (+8%) |

Worth it: the bytes are paid by the terminal's upload and by memory bandwidth, the CPU is paid out
of a 16.7 ms budget with 16 ms to spare. `--rgba` reverts it for a page that needs transparency.

### 5. Transport costs

| transport | mechanism | per frame (canvas) |
|---|---|---|
| `t=s` shared memory | native `shm_open` + `mmap`, converted straight into the mapping | 0.57 ms, 2148 KB |
| inline `o=z` base64 | zlib level 1 over `f=24` packed RGB | 13.90 ms, 480 KB |

Packing RGBA down to `f=24` RGB before compressing cut the inline path from 28.1 ms to 13.9 ms and
530 KB to 480 KB — the alpha channel is constant for an opaque page.

Shared memory needs a native addon because Node has no `shm_open`. Electron forbids external
Buffers (V8 sandbox), so the mapping is never exposed to JavaScript: conversion happens inside the
addon, writing directly into shared memory, which removes a copy rather than adding one.

### 6. Bound shared memory by bytes, not by object count

Retaining 512 objects is 40 MB of damage tiles but **5.8 GB** of full frames in shared-texture
mode, which is enough memory pressure to stall the machine. The budget is 96 MB, with a minimum of
4 frames of slack so the terminal always has time to map each object.

## Measurement methodology: the noise floor

Before trusting any regression signal, the harness was pointed at itself: the **same binary** run
twice, 10 s per case.

| case | p95 run A | p95 run B | delta |
|---|---|---|---|
| canvas/damage | 5.08 ms | 0.71 ms | **-86%** |
| canvas/texture | 0.82 ms | 1.10 ms | **+34%** |
| tiny updates | 0.15 ms | 0.15 ms | +1% |
| bytes (every case) | — | — | **+0%** |

So on a machine doing anything else, **p95 cannot decide a regression** at this sample size, while
bytes-per-frame is perfectly deterministic. That shaped the tooling:

- `--repeat N` runs each case N times and reports the **median run by frame p50**.
- `--compare <report.json>` checks **p50** (stable to ~±8% at `--repeat 3`) and **bytes/frame**
  (stable to +0%), not p95. p95/p99/max are still reported, because the tail is what a user feels —
  they just cannot serve as a pass/fail gate.
- Timing tolerance defaults to 40%; any byte change over 5% is flagged, since bytes should only
  move when behaviour actually changes.

```
npm run bench -- --repeat 3 --compare bench/baseline.json   # exits non-zero on regression
```

This caught a real regression during development: routing the status line through the metrics
histograms made it compute three percentiles per frame, each sorting an 8192-sample window. The
status line is now redrawn at 4 Hz, which nobody can tell apart and which costs nothing.

## Operational monitoring

`--metrics=<path>` streams JSON lines with timing percentiles, byte rates, tile counts, RSS,
pending shared memory, and counters for `dropped`, `fullFrameFallbacks`, `inputErrors`,
`inputUndelivered`, `inputRecoveries`, `resizes` and `windowSwaps`.

In-terminal, `ctrl+h` cycles a compact status line, a full breakdown, and off. The full line shows
frame p50/p95/max, per-stage costs, `gap p95`, tile count, drops, input counters and RSS.

Counters worth alerting on:

- `dropped` climbing → the terminal cannot keep up; the write path is applying backpressure.
- `fullFrameFallbacks` climbing on a mostly-static page → damage tracking is not working.
- `inputUndelivered` or `inputErrors` non-zero → input is being lost (see the recovery notes below).
- `inputRecoveries` non-zero → the tty read failed and the input stream was reopened.

## Robustness work behind the numbers

Failures found and fixed while measuring, each of which produced a plausible-looking but wrong
result before it was understood:

- **A tty read can fail with `EIO`,** and Node's response is to destroy stdin. No `data` event ever
  fires again, so input dies permanently while frames keep flowing. Input is now owned by
  `Terminal`, which reopens `/dev/tty` and re-asserts the modes.
- **Swapping the window used to null `this.window` first.** `onPaint` does not read it but every
  input path does, so a failure in that gap stranded input while rendering continued. The
  replacement window is now created before the old one is destroyed.
- **A throw during input dispatch aborted the loop** and, because every later chunk threw the same
  way, stranded input permanently. Parse and dispatch are now individually guarded and counted.
- **Terminal replies were parsed as keystrokes** — an OSC colour reply arrived as ~24 synthetic key
  events. OSC/DCS/APC/PM/SOS are skipped to their string terminator.
- **Requiring Chromium's device size to equal the terminal's exactly** meant one rounding pixel
  froze rendering forever. The surface must only *cover* the terminal.
- **Skipped frames used to discard their damage,** leaving regions permanently stale. Damage from
  dropped frames is accumulated and replayed.
- **A status line as wide as the screen wrapped,** scrolling the view and dragging the images with
  it. Autowrap is disabled and the line is truncated to `cols - 1`.

## Verification

```
npm run verify     # typecheck + 24 unit tests + 20 end-to-end smoke checks
```

`bench/smoke.py` drives the real binary through a synthetic kitty-graphics terminal and asserts the
behaviours that have broken before: protocol flags (`q=2`, `C=1`, `z=-1`, atomic frame wrapper), a
static page sending zero frames, input arriving with no undelivered events or errors, damage
tracking staying engaged, transport switching, the window swap keeping both rendering and input
alive, an odd-pixel resize not freezing the display, and a clean shutdown restoring the alt screen,
mouse modes, autowrap and deleting every placed image.

## GPU cost, measured

macOS exposes GPU utilization without sudo, so `bench/gpu.py` samples it alongside the busiest
processes:

```
python3 bench/gpu.py 10 "label"
```

Measured at 3400x1900 (retina full screen), machine baseline 17%:

| what is running | process CPU | GPU |
|---|---|---|
| nothing (baseline) | – | 17% |
| browser-in-terminal, idle page | **0%** | **19%** |
| browser-in-terminal, canvas particles | 10% | 30% |

An idle page costs about **two percentage points of GPU** — damage tracking means there is nothing
to rasterize, convert, transmit, decode or upload. The worst-case panel costs ~13 points, and that
is Chromium rasterizing a full-screen canvas plus the terminal uploading 2 MB per frame.

Repeatedly switching panels does not accumulate animation loops: CPU after 8 switches was **1.02x**
the CPU after zero, so there is no rAF leak.

**`--texture` is the expensive mode** and the HUD now labels it `iosurface(FULL)`. It disables
damage tracking (see above), so it sends a full frame every time — at retina that is ~11 MB/frame.
Leaving it running is the single easiest way to make this look like a GPU problem.

## A bug the whole-number harness could not see

Reported as "tearing", it was worse: strips of **stale content** surviving a panel switch, so the
new page's title read `A ny, frequent updates` — the `A` left over from the previous panel's
`A completely static page`.

Tiles were sized `round(cellWidth * tileCols)` **pixels**. A kitty placement is positioned at a
*cell*, so a tile's pixels must begin exactly where its cell begins — and that only holds when a
cell is a whole number of pixels. On a real terminal it usually is not: 3400 px across 338 columns
is 10.059 px per cell. The pixel origin then drifts from the cell origin a little more with every
tile, so tiles were cut from one place and drawn at another, overlapping their neighbours and
leaving gaps. Narrow vertical strips of the old frame survived in between.

There were **two** ways to get this wrong, and the first fix only removed one of them:

1. Sizing a tile as `round(cellWidth * tileCols)` **pixels** drifts off the grid whenever a cell is
   not a whole number of pixels.
2. Deriving the cell size as `windowPixels / columns` is *not the terminal's cell size*. Terminals
   use an **integer** cell and keep the remainder as padding, so the quotient is slightly wrong and
   the drift comes straight back.

The terminal will simply say: **`CSI 16 t` reports the cell size in pixels**. The probe now asks for
it, tile bounds are exact integer multiples of it, and `tile.col` / `tile.row` are exact integers.
If a terminal does not answer `CSI 16 t`, the fallback division is used and a warning is printed,
because that path can misplace tiles.

The reason it survived every benchmark is worth recording: the harness used 1600x900 with a 160x45
grid — exactly 10.0 x 20.0 px cells, where the buggy arithmetic and the correct arithmetic agree.
**The synthetic terminal now answers `CSI 16 t` with a cell size that does not divide the window**
(157 cols x 10 px = 1570 of 1600; 44 rows x 20 px = 880 of 900), exactly like a terminal keeping
padding. A unit test asserts exact cell alignment and an exact tile cover across three such
geometries.

## A second stale-content bug: image id is a z-order

Reported as `Sanvas particles` — an `S` from the previous panel's `Scroll a long list` sitting on
top of the new page. The tile-placement arithmetic was already fixed; this was a different cause.

**At equal z-index, the higher kitty image id composites on top.** Tiles use ids 2 and up; the
full frame uses id 1. When a frame fell back to full, the code cleared its own bookkeeping but
never told the terminal to delete the tile placements — so old tiles kept floating *above* a
perfectly correct full frame. A full frame now retires every tile placement before transmitting.

This is also why `--texture` looked clean at the time: on content that changes everywhere it sends
a full frame every time, so no tile is ever placed and the stale-tile bug could not appear. The
mode that looked better was avoiding the bug, not avoiding the cost.

## Adaptive source selection: tried, and removed

The measurement is real. On a full-screen canvas, where damage is worthless because everything
changes, the bitmap path is ~3x more expensive because Chromium must read the frame back to the CPU
before we start:

| full-screen canvas | per frame | bytes |
|---|---|---|
| CPU bitmap | 4.23 ms | 11.3 MB |
| shared texture | **1.42 ms** | 11.3 MB |

Switching automatically on a running full-frame ratio was implemented and then removed the same day,
for two reasons that no benchmark would have surfaced:

1. **It reloads the page.** `useSharedTexture` is a `BrowserWindow` option, so changing it requires
   a new window, and a new window means `loadFile` — every switch silently discards the app's
   state. Saving 3 ms is not worth restarting the user's application underneath them.
2. **The signal is degenerate.** In texture mode every frame is a full frame, so the ratio pins at
   1.0 and the condition for switching back can never be satisfied. It was a one-way door.

`--texture` remains an explicit choice for workloads known to change everywhere. The status line
now shows `full NN%` — the share of frames going out whole — so the decision can be made from
evidence without the program making it for you.

### Retiring stale tiles without trusting bookkeeping

The first fix retired the tiles we *believed* were placed. That is not enough: the set is cleared
on a window swap, a resize, and whenever a delete-all is issued that the terminal may not have
honoured — and any tile we lose track of keeps compositing above every future full frame, forever.

A full frame now retires the **entire tile id range** unconditionally, guarded by a flag so an
all-full-frame workload emits the deletes once rather than every frame. Roughly 3 KB of deletes
against an 11 MB frame is not worth being clever about.

## Input bugs that only a real keyboard finds

Two defects survived every automated test because the harness sent synthetic sequences that never
included these cases:

- **Space typed nothing.** Codepoint 32 was mapped to the named key `Space`, and named keys
  deliberately emit no `char` event — so the keystroke arrived with no character attached.
- **Pressing Shift typed a Private Use Area glyph.** At kitty keyboard flags >= 8 modifier keys
  report themselves (shift is 57441). With no name for that code, the parser fell back to
  `String.fromCodePoint(57441)` and inserted a PUA character into the focused field.

Both now have regression tests: space must carry text, and every key in the functional PUA range
(57344-57534) without a name must resolve to nothing at all.

## Visual regression testing

Everything above validates the bytes we emit. That cannot catch what a user actually sees, and
every hard bug in this project has been a compositing bug: tiles drawn beside the pixels they came
from, stale placements floating above a correct frame, images recycled before the terminal read
them. Four rounds of "all tests pass" were followed by a screenshot showing obvious corruption.

`bench/kitty_compositor.py` is a **reference terminal**: it decodes the escape stream and
reconstructs the screen, implementing transmit/display, chunked payloads, `f=24`/`f=32`, zlib,
shared-memory reads, deletes, and the compositing order that matters — *by z, then by image id,
then by placement order*, which is precisely the rule that let stale tiles float on top.

`bench/visual.py` drives the real app through nine panel switches (full-frame fallback, scattered
damage, tiny damage, static pages), then asks it to dump the frame Chromium actually rendered
**without transmitting it** — so a correct stream must already be showing that frame. The composited
screen is then diffed against it pixel by pixel.

```
npm run visual              # default shared-memory path
npm run visual -- --texture # GPU shared texture path
```

Both currently report **0 mismatched pixels out of 1,440,000**. On failure it writes
`/tmp/composited.png` and `/tmp/expected.png` so the difference can be looked at.

The harness reads shared-memory objects the way a terminal does (`shm_open` + `mmap`, then unlink),
which is what exposed the reclamation bug below.

### Reclaiming shared memory by object count was wrong

A frame that damages many tiles emits **one shared-memory object per tile** — 880 of them at a
157x44 grid with 4x2 tiles. The retention policy kept the most recent 512 *objects* and recycled
names from a 512-entry ring, so a single busy frame could unlink objects belonging to the frame
being transmitted, and reuse a name whose object the terminal had not read yet. Tiles vanish; a
run of them looks like the screen going blank.

Retention is now by **age in frames** (never reclaim anything younger than 3 frames) within a byte
budget, and the name space is 65536 rather than 512.

## The context menu had to be rebuilt in the page

A native Electron menu (`Menu.popup`) is an OS window. Under offscreen rendering there is no window
to attach it to, so it would open on the desktop — invisible to the terminal, which is why right
click appeared to do nothing.

The menu is now drawn **in the page**: `webContents.on('context-menu')` injects an overlay into a
closed shadow root (so the page's styles cannot reach it and it cannot disturb the page's layout),
positioned at the click and flipped when it would run past an edge. It composites through the
normal damage pipeline like any other pixels — the visual test opens it and confirms 0 mismatched
pixels with the menu on screen.

Chosen actions cross back over a preload `contextBridge` to `webContents.cut/copy/paste/selectAll`,
and a copy is additionally pushed to the **terminal's** clipboard with OSC 52 — otherwise it would
only exist inside Chromium.

### Native `<select>` popups had the same problem, and the same fix

A select popup is a native widget in its own offscreen surface, which Electron does not hand us —
so in a terminal the control highlighted and nothing opened. `src/selectshim.ts` is injected into
every page on `dom-ready`: it intercepts the interaction in the capture phase, suppresses the
native popup and draws an equivalent listbox in a closed shadow root, with keyboard navigation and
proper `input`/`change` events so the page cannot tell the difference. Multi-selects and list boxes
are left alone.

Autofill and other Chromium-internal popups remain unavailable.

## Dragging lagged because input was not coalesced

A drag reports mouse motion far faster than frames can be produced, and every event was dispatched
synchronously from the stdin handler — so one input chunk became hundreds of IPC round trips that
blocked the main process while paints queued behind them. Motion is idempotent, so consecutive
moves in a batch are now collapsed to the newest position. Measured: **300 motion events produce 36
frames** instead of 300 dispatches. Presses, releases and wheel events are never coalesced.

## Text fields had no caret

An offscreen window is never focused, and Chromium only blinks a caret in a **focused view** — so
text inputs looked dead even though typing worked. `webContents.focus()` is not enough here:
`document.hasFocus()` stays false. `BrowserWindow.focusOnWebView()` marks the web view active
**without showing a window**, so it cannot steal OS focus from the terminal, which would send the
user's keystrokes to an invisible Electron window instead of Ghostty.

It is applied on load, on terminal focus-in, and on every mouse press. Verified by watching for the
blink: a focused field produces narrow `1x15` repaints roughly twice a second.

## Compression and shared memory are not combinable, and should not be

A reasonable question is why the fast path does not compress. They solve different problems:

- **Shared memory** removes the transfer entirely. The terminal maps the same physical pages we
  wrote; nothing crosses the pty.
- **Compression** pays for itself only when bytes cross something slow — the pty, or a network.

Compressing into shared memory would spend zlib's cost to shrink a transfer that is already free.
The measured trade is lopsided: a full frame costs ~14 ms to deflate (`canvas/full-b64` encode
time) against ~0.4 ms for the equivalent memcpy. So: **local uses shared memory and does not
compress; remote compresses and cannot use shared memory.** There is no configuration that wants
both.

### Shared memory silently does nothing over SSH, so it is now probed

A remote terminal cannot open a shared-memory object on our machine. Nothing detected this: the
escape was accepted, the object was never read, and the screen simply did not update.

The capability probe now creates a real one-pixel object and asks the terminal to read it with
`a=q,t=s`. If the reply is not OK — any remote session, or any terminal without support — the
inline compressed transport is used instead, and a line is printed saying so. The status line shows
what is **actually** in use (`tile-b64(fallback from shm)`) rather than what was requested; a mode
that quietly differs from the label is how an afternoon gets lost.

The smoke suite covers it with a synthetic terminal that refuses the shared-memory probe.

## Measured in real Ghostty

30 s at 1328x1598 px (83x47 cells, 16x34 px cells), default panel, shared-memory path:

| | value |
|---|---|
| capabilities | `kittyGraphics: true`, `sharedMemory: true` — the probe works against the real thing |
| mode / source | `tile-shm` / bitmap |
| frame p50 / p95 / max | **0.16 / 2.81 / 14.31 ms** |
| copy p50 | 0.12 ms |
| write p50 / max | 0.02 / 13.66 ms |
| bytes/frame p50 / p95 | 638 KB / 6217 KB (a full frame is 6.37 MB at `f=24`) |
| sustained rate | 77.5 MiB/s |
| tiles p50 | 3 |
| full-frame fallbacks | 154 of 1197 frames (13%) |

**App-side cost is about 1% of the frame budget** (0.16 ms of 16.7 ms), and the per-second series
holds a flat 60 fps from t=4 to t=21. After that the rate falls to 4-5 fps while frame cost stays at
0.16 ms — that is Chromium not painting an idle page, not a stall on our side. `gap p99` of 318 ms
measures the same thing and should be read as "nothing changed", not "we were late".

### It found a real defect: retention was pinned at the budget

The run reported **95.9 MiB of shared memory held across 626 objects, for the whole session.**
Reclamation only ran when the byte budget was exceeded, so the budget behaved as a *target* rather
than a ceiling: objects accumulated until they hit 96 MiB and stayed there.

Objects are now reclaimed once they are simply old (8 frames, ~130 ms at 60 fps), with the byte
budget kept as an earlier trigger for bursts. Same throughput, far less resident memory:

| | before | after |
|---|---|---|
| resident shared memory | 95.9 MiB / 626 objects | **12.8 MiB / 448 objects** |
| canvas frame p50 | 0.89 ms | 0.67 ms |
| canvas bytes/frame | 1641 KB | 1611 KB |

### A harness bug found alongside it

Adding the shared-memory probe silently invalidated the benchmark: its synthetic terminal did not
answer the probe, so the app correctly fell back to the inline transport and the benchmark measured
**the wrong path** (13.55 ms/frame, 285 tiles — the compressed path, reported as if it were the
default). A harness that quietly measures something other than what it claims is worse than no
harness, so `bench/bench.py` now answers the probe, as `smoke.py` and `visual.py` already did.

## DevTools, rendered in the terminal

DevTools is an ordinary web page served from `devtools://`, and `webContents.setDevToolsWebContents`
lets any `WebContents` host it — including a second **offscreen** one. So it composites into the
terminal exactly like the page does.

That required generalising the renderer from one window to **surfaces**. A surface is one Chromium
window occupying a rectangle of the terminal, and each owns:

- its own tiler, tile hashes and placement bookkeeping, because damage is per-window;
- **its own kitty image id range** (`index * 4096`), because at equal z the higher id composites on
  top — two surfaces sharing ids would draw over each other, which is the same class of bug that
  produced stale tiles earlier;
- its own cell offset, so tiles are placed relative to the surface's corner.

The split lands on a cell boundary, so both surfaces stay exactly cell-aligned and neither drifts.
Input is routed by hit-testing the pointer against each surface and translating into that window's
coordinate space; keys go to whichever surface was last clicked.

`ctrl+i` toggles it; `ctrl+o` cycles the dock through right, left, bottom and top; `--devtools-dock`
and `--devtools-split` set the defaults. Verified across all four docks that the two surfaces
occupy disjoint cell ranges:

| dock | devtools cols | devtools rows | page starts |
|---|---|---|---|
| right | 89-159 | 1-36 | col 1 |
| left | 1-71 | 1-36 | col 73 |
| bottom | 1-151 | 26-41 | row 1 |
| top | 1-151 | 1-16 | row 21 |

### Two things DevTools exposed

**Chromium's logging was corrupting the screen.** It logs from C++ straight to file descriptor 2,
so a line like `[76788:0828/110434:ERROR:CONSOLE:1] "Request Autofill.setAddresses failed"` landed
in the middle of a rendered image. Overriding `process.stderr` in JavaScript cannot stop it,
because those writes never pass through Node — only `dup2` can. The addon now points fd 2 at a log
file (`--log=<path>`, default `/tmp/et-chromium.log`) as soon as the terminal is ours, and
`--disable-logging` reduces the volume at the source. Startup errors still reach the user, because
the redirect happens only after the probe succeeds.

**The status line had a surface underneath it.** Both were drawing into the last row, so the HUD
and DevTools' element breadcrumb overlapped. The layout now reserves that row when the status line
is visible, and re-lays out when `ctrl+h` shows or hides it.

### Or attach from a browser

`--devtools-port=9223` exposes Chrome's remote debugging endpoint (`/json/list` returns the page
target). Full DevTools then attaches from any browser. A nice property of offscreen rendering:
the inspector's highlight overlay is drawn by Chromium **into the page**, so hovering a node in the
browser lights that element up in the terminal.

## Known limits

- Terminal-side decode and present are not measured by the harness, and Ghostty's implementation is
  acknowledged upstream as unprofiled.
- The inline path is the SSH path, and 480 KB/frame at Ghostty's ~14.5 MB/s is ~30 fps for
  full-viewport animation. Static and text-heavy content is effectively free.
- Scroll arrives as wheel *ticks*, not pixel deltas; there is no IME; text is pixels, so it is not
  selectable by the terminal and invisible to tmux.
