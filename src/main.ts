/**
 * browser-in-terminal — stream an Electron (Chromium) UI into a kitty-graphics terminal.
 *
 * Default path: Chromium renders offscreen and hands back a CPU bitmap plus a dirty rect. That
 * rect is the *union* of all damage, so it is used only to narrow a search: a native addon hashes
 * the tiles inside it and converts just the tiles that actually changed, BGRA→RGBA, straight into
 * a POSIX shared-memory object. The terminal maps that object (kitty `t=s`) — no base64 and no
 * PTY payload. See PERF.md.
 *
 * Shared-texture path (--texture): Chromium renders into a GPU shared texture; on macOS that is an
 * IOSurface, which on Apple silicon is CPU-addressable, so the addon locks it and reads it back
 * without a GPU roundtrip. It avoids a copy but *disables Chromium's damage reporting* (every paint
 * arrives full-frame), and sending 5.6 MB costs far more than the copy saves — so it is not the
 * default.
 *
 * Inline path (--mode=0/2): zlib+base64 over the PTY. The fallback when shared memory is
 * unavailable, which is the case whenever the terminal is on another machine.
 */

import { app, BrowserWindow, clipboard, ipcMain, screen, type NativeImage, type Rectangle } from 'electron'
import { join } from 'node:path'
import { appendFileSync, writeFileSync } from 'node:fs'

import { Terminal, type Capabilities, type Geometry } from './terminal.js'
import { InputParser, type KeyEvent, type MouseEvent as TermMouseEvent, type TermEvent } from './input.js'
import { Tiler, type Rect, type Tile } from './framebuffer.js'
import {
  MODES,
  modeName,
  placeShm,
  placeInline,
  deleteImage,
  cursorTo,
  BEGIN_FRAME,
  END_FRAME,
  type Mode,
} from './kitty.js'
import { loadNative, nativeLoadError, type TermBridge } from './native.js'
import { hideMenuScript, itemsFor, showMenuScript } from './menu.js'
import { SELECT_SHIM } from './selectshim.js'
import { Surface } from './surface.js'
import { Metrics } from './metrics.js'

/**
 * Cap the offscreen renderer at the display refresh. 120 was wasteful: the terminal presents at
 * the display rate, so the extra frames cost Chromium raster, our copy, AND Ghostty's decode and
 * texture upload for nothing. Override with --fps N.
 */
const FRAME_RATE = (() => {
  const flag = process.argv.find(a => a.startsWith('--fps='))
  const parsed = flag ? Number(flag.slice(6)) : NaN
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 240 ? parsed : 60
})()
/**
 * Frames per second while the terminal does not have focus. Defaults to the focused rate.
 *
 * Focus is not visibility: an unfocused terminal is usually still on screen and being glanced at,
 * which is exactly how a dashboard gets used, and a throttled one reads as broken. Throttling was
 * also solving a problem damage tracking already solved — a static page costs zero frames and zero
 * bytes whatever the frame rate, so the cap only ever mattered for animating content.
 * Use --unfocused-fps=N to opt into a lower background rate, or =0 to pause entirely.
 */
const UNFOCUSED_FRAME_RATE = (() => {
  const flag = process.argv.find(a => a.startsWith('--unfocused-fps='))
  const parsed = flag ? Number(flag.slice(16)) : NaN
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 240 ? parsed : FRAME_RATE
})()
/** If damage touches more than this fraction of the screen, one full upload beats many tiles. */
const FULL_FRAME_THRESHOLD = 0.45
/** Ring of shared-memory names. Creating a name unlinks any stale object first, bounding leaks. */
/**
 * Name space for shared-memory objects. This must be far larger than the number of objects that
 * can be in flight, because creating a name unlinks any object already holding it: a single frame
 * can emit one object per damaged tile (880 at a 157x44 grid with 4x2 tiles), so a small ring
 * recycles names the terminal has not read yet, and tiles vanish.
 */
const SHM_NAME_SPACE = 65536
/** Never reclaim an object younger than this many frames: the terminal has to map it first. */
const SHM_MIN_FRAMES = 3
/**
 * Always reclaim once an object is this old. Measured on real Ghostty 2026-08-28: with reclamation
 * driven only by the byte budget, retention grew to the budget and stayed pinned there — 626
 * objects, 96 MiB resident for the whole session. The budget was acting as a target rather than a
 * ceiling. Eight frames is ~130 ms at 60fps, far more slack than mapping needs.
 */
const SHM_MAX_FRAMES = 8
/**
 * Cap on shared memory we keep alive waiting for the terminal to map and unlink it. Bounding by
 * OBJECT COUNT was a bug: 512 damage tiles is ~40MB, but 512 full frames in shared-texture mode is
 * ~5.8GB, and the resulting memory pressure stalls the whole machine. Bound the bytes instead.
 */
const SHM_BYTES_BUDGET = 96 * 1024 * 1024

type Modifier = 'shift' | 'control' | 'alt' | 'meta'

function flagValue(name: string): string | null {
  const prefix = `--${name}=`
  const found = process.argv.find(a => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : null
}

/** Where to stream metrics as JSON lines, for monitoring or a benchmark run. */
const METRICS_PATH = flagValue('metrics')
/** Seconds to run before exiting on its own, so a benchmark needs no interaction. */
const RUN_SECONDS = Number(flagValue('duration') ?? NaN)
/** Demo panel to open on startup, so a benchmark can target one workload. */
const SCENARIO = flagValue('scenario')
/** Discard the first N seconds of samples: startup is not steady state. */
const WARMUP_SECONDS = Number(flagValue('warmup') ?? 2)
/**
 * Tile size in terminal cells. Measured 2026-08-27 on scattered small damage: 4x2 tiles cost
 * 81KB/frame over 13 tiles, 10x5 cost 156KB over 4 tiles. Smaller tiles track damage more finely
 * (fewer bytes) but cost more escapes and more per-tile work (more CPU). The right choice depends
 * on which side is scarce, so it follows the transport: shared memory is CPU-bound and prefers
 * larger tiles; the inline path pushes every byte through the pty and prefers smaller ones.
 */
/*
 * Adaptive source selection was tried and removed on 2026-08-27.
 *
 * The idea was to follow the measurement: when damage is worthless (the whole viewport changes
 * every frame) the shared texture is ~3x cheaper, so switch to it automatically. Two things make
 * it unworkable:
 *
 *   1. `useSharedTexture` is a BrowserWindow option, so changing it needs a new window — which
 *      reloads the page and throws away all of its state. Silently reloading the user's app to
 *      save 3 ms is not a trade worth making.
 *   2. The signal is degenerate. In texture mode every frame is a full frame, so the full-frame
 *      ratio pins at 1.0 and the condition to switch back can never be met.
 *
 * `--texture` stays as an explicit choice for workloads that are known to change everywhere.
 */

/** Where DevTools docks, as in a browser. Cycled at runtime with ctrl+o. */
type Dock = 'right' | 'left' | 'bottom' | 'top'
const DOCKS: readonly Dock[] = ['right', 'left', 'bottom', 'top']

function initialDock(): Dock {
  const flag = flagValue('devtools-dock')
  return DOCKS.includes(flag as Dock) ? (flag as Dock) : 'right'
}

/** Fraction of the terminal the PAGE keeps when DevTools is docked beside it. */
const DEVTOOLS_SPLIT = (() => {
  const flag = flagValue('devtools-split')
  const parsed = flag ? Number(flag) : NaN
  return Number.isFinite(parsed) && parsed > 0.2 && parsed < 0.9 ? parsed : 0.55
})()

/** DEC 2026 synchronized output. --no-atomic disables it, to isolate a terminal that mishandles it. */
const ATOMIC_FRAMES = !process.argv.includes('--no-atomic')

/** How often the status line is redrawn. Percentiles are not free; 4 Hz is plenty to read. */
const HUD_INTERVAL_MS = 250

/**
 * Send 3-byte RGB rather than RGBA over shared memory. Alpha is constant for an opaque page, so
 * this removes a quarter of the bytes we write AND a quarter of what the terminal has to upload.
 * --rgba disables it, for a page that genuinely needs transparency.
 */
const PACK_RGB = !process.argv.includes('--rgba')

/**
 * Expose Chrome's remote debugging endpoint. Full DevTools then attaches from any browser, and
 * because the inspector's highlight overlay is drawn by Chromium into the page itself, hovering a
 * node lights it up in the terminal.
 */
const DEVTOOLS_PORT = flagValue('devtools-port')

/** Where Chromium's own logging goes once we own the screen. */
const LOG_PATH = flagValue('log') ?? '/tmp/et-chromium.log'

/** Ground-truth RGBA dump path for the visual test (see bench/visual.py). */
const DUMP_SOURCE = flagValue('dump-source')

const TILE_COLS_FLAG = flagValue('tile-cols')
const TILE_ROWS_FLAG = flagValue('tile-rows')

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

function clampRect(r: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(r.x, width))
  const y = Math.max(0, Math.min(r.y, height))
  return {
    x,
    y,
    width: Math.min(r.x + r.width, width) - x,
    height: Math.min(r.y + r.height, height) - y,
  }
}

/** Where this frame's pixels live. */
type PixelSource =
  | { kind: 'texture'; handle: Buffer; swapRB: boolean }
  | { kind: 'bitmap'; bitmap: Buffer; stride: number; swapRB: boolean }

class Bridge {
  private readonly term = new Terminal(process.stdin, process.stdout)
  private readonly parser = new InputParser()
  private readonly native: TermBridge | null = loadNative()
  private readonly page = new Surface(0, null)
  private readonly devtools = new Surface(1, null)
  /** Which surface keyboard input goes to. */
  private focusedSurface: Surface = this.page
  private devtoolsOpen = false
  private dock: Dock = initialDock()
  private geo: Geometry | null = null
  private capabilities: Capabilities = {
    kittyGraphics: false,
    sharedMemory: false,
    responded: false,
    da1: '',
  }
  private modeIndex = Number(flagValue('mode') ?? process.env['ET_MODE'] ?? 3)
  private scale = 1
  // Default OFF. Measured 2026-08-27: useSharedTexture makes Chromium report the whole window as
  // dirty on every paint (357/357 vs 1/357), so it costs 5.6MB/frame where damage tracking costs
  // ~78KB. Worth turning on only for content that changes fully every frame (video, canvas, scroll).
  private useTexture = process.argv.includes('--texture')
  /** 0 = off, 1 = compact, 2 = full breakdown. */
  private hudLevel = 1
  private lastHudAt = 0
  private draining = false
  private resizing = false
  private lastInputAt = 0
  private lastInputKind = '-'
  private focused = true
  private paused = false
  /** Running share of frames that had to go out whole; surfaced in the status line. */
  private fullFrameRatio = 0
  private lastClickAt = 0
  private lastClickX = 0
  private lastClickY = 0
  private clickCount = 1
  private modeTimer: NodeJS.Timeout | null = null
  private disposed = false
  private shmSeq = 0
  private readonly pendingShm: { name: string; bytes: number; frame: number }[] = []
  private frameSeq = 0
  private pendingShmBytes = 0
  private lastInputError = ''
  private dumpPending = false
  private readonly metrics = new Metrics()
  private metricsTimer: NodeJS.Timeout | null = null

  /**
   * Divide the terminal between the page and DevTools, docked on any edge as a browser would.
   * The split lands on a cell boundary so both surfaces stay exactly cell-aligned, which is what
   * keeps their placements from drifting apart.
   */
  private layoutSurfaces(geo: Geometry): void {
    const cellW = geo.cellWidth
    const cellH = geo.cellHeight
    const gridCols = Math.floor(geo.pxWidth / cellW)
    // Keep the status line's row to itself: a surface drawn under it fights with the text, and
    // with DevTools open its breadcrumb bar landed in exactly that row.
    const reserved = this.hudLevel > 0 ? 1 : 0
    const gridRows = Math.max(1, Math.floor(geo.pxHeight / cellH) - reserved)

    if (!this.devtoolsOpen) {
      this.page.place(0, 0, gridCols * cellW, gridRows * cellH, 0, 0)
      this.devtools.place(0, 0, 0, 0, 0, 0)
      return
    }

    const horizontal = this.dock === 'left' || this.dock === 'right'
    const total = horizontal ? gridCols : gridRows
    // Keep both panes usable: neither side drops below 10 cells.
    const pageSpan = Math.max(10, Math.min(total - 10, Math.round(total * DEVTOOLS_SPLIT)))
    const devSpan = total - pageSpan
    const pageFirst = this.dock === 'right' || this.dock === 'bottom'
    const firstSpan = pageFirst ? pageSpan : devSpan
    const secondSpan = pageFirst ? devSpan : pageSpan

    const place = (surface: Surface, offset: number, span: number): void => {
      if (horizontal) {
        surface.place(offset * cellW, 0, span * cellW, gridRows * cellH, offset, 0)
      } else {
        surface.place(0, offset * cellH, gridCols * cellW, span * cellH, 0, offset)
      }
    }
    place(pageFirst ? this.page : this.devtools, 0, firstSpan)
    place(pageFirst ? this.devtools : this.page, firstSpan, secondSpan)
  }

  /** Move DevTools to the next edge, as the browser's dock-side control does. */
  private cycleDock(): void {
    if (!this.devtoolsOpen || !this.geo) return
    this.dock = DOCKS[(DOCKS.indexOf(this.dock) + 1) % DOCKS.length] ?? 'right'
    this.layoutSurfaces(this.geo)
    this.resetSurfaces()
    this.resizeWindows(this.geo)
  }

  /** Open or close DevTools rendered beside the page, inside the terminal. */
  private toggleDevtools(): void {
    const geo = this.geo
    const page = this.page.window
    if (!geo || !page || page.isDestroyed()) return

    this.devtoolsOpen = !this.devtoolsOpen
    this.layoutSurfaces(geo)
    this.resetSurfaces()

    if (!this.devtoolsOpen) {
      page.webContents.closeDevTools()
      const host = this.devtools.window
      this.devtools.window = null
      this.focusedSurface = this.page
      if (host && !host.isDestroyed()) host.destroy()
      this.resizeWindows(geo)
      return
    }

    // DevTools is just another web page, so it can be hosted in a second offscreen window and
    // composited into its own slice of the terminal.
    const host = this.createSurfaceWindow(this.devtools, this.devtools.width, this.devtools.height, false)
    page.webContents.setDevToolsWebContents(host.webContents)
    page.webContents.openDevTools({ mode: 'detach' })
    this.focusedSurface = this.devtools
    host.focusOnWebView()
    this.resizeWindows(geo)
  }

  /** Size each Chromium window to its slice of the terminal. */
  private resizeWindows(geo: Geometry): void {
    for (const surface of [this.page, this.devtools]) {
      const win = surface.window
      if (!win || win.isDestroyed() || surface.width === 0) continue
      win.setSize(
        Math.max(1, Math.ceil(surface.width / this.scale)),
        Math.max(1, Math.ceil(surface.height / this.scale)),
      )
    }
    void geo
  }

  /** The page window, for the many places that only care about it. */
  private get window(): BrowserWindow | null {
    return this.page.window
  }

  private get mode(): Mode {
    const m = MODES[this.modeIndex]
    return m ?? { strategy: 'tile', transport: 'shm' }
  }

  private tileSize(): { cols: number; rows: number } {
    const bytesBound = this.effectiveTransport() === 'b64'
    return {
      cols: Number(TILE_COLS_FLAG ?? (bytesBound ? 4 : 10)),
      rows: Number(TILE_ROWS_FLAG ?? (bytesBound ? 2 : 5)),
    }
  }

  /** shm needs the native addon; fall back to the inline base64 path without it. */
  /** Create a one-pixel shared-memory object so the probe can ask the terminal to read it. */
  private makeShmProbe(): string | undefined {
    const native = this.native
    if (!native) return undefined
    const name = `/et${process.pid % 100000}-probe`
    try {
      native.shmFromBitmap(Buffer.alloc(4), 4, 0, 0, 1, 1, name, false, true)
      return name
    } catch {
      return undefined
    }
  }

  private effectiveTransport(): Mode['transport'] {
    const t = this.mode.transport
    if (t === 'shm' && !this.native) return 'b64'
    // Shared memory is local-only: over SSH the terminal cannot open our object and would draw
    // nothing at all. Compression is the right answer there, and it is what the b64 path does.
    if (t === 'shm' && !this.capabilities.sharedMemory) return 'b64'
    // The shared texture never produces a CPU buffer, so it can only go out over shm.
    if (t === 'b64' && this.useTexture && this.native?.hasIOSurface) return 'shm'
    return t
  }

  async start(): Promise<void> {
    if (!this.term.isTty()) {
      process.stderr.write(
        'browser-in-terminal: stdin/stdout is not a terminal.\n' +
          'Run from a kitty or ghostty shell: npm start\n',
      )
      app.exit(1)
      return
    }

    this.term.enable()
    try {
      const probe = await this.term.probe(2000, this.makeShmProbe())
      this.geo = probe.geometry
      this.capabilities = probe.capabilities
    } catch (err) {
      this.term.disable()
      process.stderr.write(`browser-in-terminal: ${(err as Error).message}\n`)
      app.exit(1)
      return
    }
    if (!this.capabilities.sharedMemory && this.native) {
      process.stderr.write(
        'browser-in-terminal: the terminal cannot read our shared memory (remote session?); ' +
          'using the inline compressed transport instead.\n',
      )
    }
    if (DEVTOOLS_PORT) {
      process.stderr.write(
        `browser-in-terminal: DevTools listening on http://localhost:${DEVTOOLS_PORT} — ` +
          'open it in a browser and pick the page to inspect.\n',
      )
    }
    if (!this.geo.cellSizeReported) {
      // Without CSI 16 t we have to divide window pixels by columns, which is not the terminal's
      // cell size and makes every tile placement drift. Say so rather than silently misdrawing.
      process.stderr.write(
        'browser-in-terminal: terminal did not report its cell size (CSI 16 t); ' +
          'falling back to window/columns, which can misplace tiles.\n',
      )
    }
    if (!this.capabilities.kittyGraphics && !process.argv.includes('--force')) {
      this.term.disable()
      process.stderr.write(
        'browser-in-terminal: this terminal did not acknowledge the kitty graphics protocol ' +
          `(DA1: ${this.capabilities.da1}).\n` +
          'Use kitty or ghostty, or pass --force to try anyway.\n',
      )
      app.exit(1)
      return
    }

    // From here the screen is ours. Chromium writes to fd 2 from C++ — a single log line lands
    // in the middle of an image and corrupts the display — so send it to a file instead.
    try {
      this.native?.redirectStderr(LOG_PATH)
    } catch {
      /* without the addon we simply live with the noise */
    }
    this.term.attach((chunk: Buffer) => this.onInput(chunk))
    // Re-assert the mouse/keyboard modes periodically: if anything resets them, SGR-pixels
    // reverts to cell coordinates and every click lands in the wrong place.
    this.modeTimer = setInterval(() => {
      // Losing raw mode is the failure that looks like a freeze: the terminal starts echoing the
      // escapes we asked for and nothing reaches the app. Check for it rather than hoping.
      this.term.ensureRawMode(this.native ? () => this.native?.terminalIsRaw() ?? true : undefined)
      this.term.reassertModes()
    }, 2000)
    process.stdout.on('drain', () => {
      this.draining = false
      // A dropped frame took its damage with it. Nothing else will repaint that region on a
      // static page, so ask Chromium for a fresh paint and replay the accumulated damage.
      if (this.page.pendingDamage || this.devtools.pendingDamage) {
        this.window?.webContents.invalidate()
      }
    })
    process.on('SIGWINCH', () => void this.onResize())
    if (METRICS_PATH) {
      writeFileSync(METRICS_PATH, '')
      this.metricsTimer = setInterval(() => this.emitMetrics(false), 1000)
    }
    if (Number.isFinite(RUN_SECONDS) && RUN_SECONDS > 0) {
      setTimeout(() => this.quit(), RUN_SECONDS * 1000)
    }
    if (Number.isFinite(WARMUP_SECONDS) && WARMUP_SECONDS > 0) {
      // Startup paints, first full frame and JIT warmup are not steady state.
      setTimeout(() => this.metrics.resetTimings(), WARMUP_SECONDS * 1000)
    }
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => this.quit())

    this.scale = screen.getPrimaryDisplay().scaleFactor || 1
    if (this.geo) {
      this.layoutSurfaces(this.geo)
      this.createWindow(this.geo)
    }
  }

  private createWindow(geo: Geometry): BrowserWindow {
    return this.createSurfaceWindow(this.page, geo.pxWidth, geo.pxHeight, true)
  }

  /** Build the Chromium window backing a surface, sized to that surface's rectangle. */
  private createSurfaceWindow(
    surface: Surface,
    pxWidth: number,
    pxHeight: number,
    loadPage: boolean,
  ): BrowserWindow {
    // deviceScaleFactor makes Chromium's device pixels exactly match the terminal's, so there is
    // nothing to measure or correct after the fact.
    // ceil, not round: Chromium's device size must cover the terminal. Rounding down by one
    // pixel used to make every frame fail the size check below and freeze the display forever.
    const width = Math.max(1, Math.ceil(pxWidth / this.scale))
    const height = Math.max(1, Math.ceil(pxHeight / this.scale))

    const win = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: { useSharedTexture: this.useTexture, deviceScaleFactor: this.scale },
        backgroundThrottling: false,
        preload: join(__dirname, 'preload.js'),
      },
    })
    surface.window = win
    win.webContents.setFrameRate(this.focused ? FRAME_RATE : UNFOCUSED_FRAME_RATE)
    win.webContents.on('paint', (details, dirty: Rectangle, image: NativeImage) => {
      const texture = details.texture
      try {
        // Ignore frames from a window we have already replaced: they carry the old mode and size.
        if (win === surface.window) this.onPaint(surface, dirty, image, texture ?? null)
      } finally {
        texture?.release()
      }
    })
    win.webContents.on('cursor-changed', (_event, type) => this.setCursor(type))
    // Native <select> popups render into a surface offscreen rendering does not expose, so a
    // dropdown highlights and never opens. Replace it with an equivalent drawn in the page.
    win.webContents.on('dom-ready', () => {
      void win.webContents.executeJavaScript(SELECT_SHIM).catch(() => {
        /* a page that refuses injection simply keeps the native behaviour */
      })
    })
    // A native menu is an OS window and would open on the desktop, invisible to the terminal.
    // Draw it in the page instead, where it composites through the normal pipeline.
    win.webContents.on('context-menu', (_event, params) => {
      const items = itemsFor({
        isEditable: params.isEditable,
        editFlags: params.editFlags,
        selectionText: params.selectionText,
        linkURL: params.linkURL,
      })
      void win.webContents.executeJavaScript(showMenuScript(params.x, params.y, items))
    })
    if (!loadPage) return win
    void win.loadFile(join(__dirname, '..', 'demo', 'index.html')).then(
      () => {
        // An offscreen window is never focused, and Chromium only blinks a caret in a focused
        // view — so text fields looked dead even though typing worked. focusOnWebView() marks the
        // web view active WITHOUT showing a window, so it cannot steal OS focus from the terminal
        // (webContents.focus() alone leaves document.hasFocus() false here).
        win.focusOnWebView()
        if (SCENARIO) void win.webContents.executeJavaScript(`window.__show(${JSON.stringify(SCENARIO)})`)
      },
      () => {
        /* load failures surface as an empty frame; nothing useful to do here */
      },
    )
    return win
  }

  // ---------- rendering ----------

  private onPaint(
    surface: Surface,
    dirty: Rectangle,
    image: NativeImage,
    texture: Electron.OffscreenSharedTexture | null,
  ): void {
    if (this.disposed || !this.geo) return
    if (this.paused) {
      this.accumulate(surface, { x: dirty.x, y: dirty.y, width: dirty.width, height: dirty.height })
      return
    }
    if (this.draining) {
      this.metrics.count('dropped')
      this.accumulate(surface, { x: dirty.x, y: dirty.y, width: dirty.width, height: dirty.height })
      return
    }

    let source: PixelSource
    let deviceWidth: number
    let deviceHeight: number
    let damage: Rect

    if (texture && this.native?.hasIOSurface) {
      const info = texture.textureInfo
      const handle = info.handle.ioSurface
      if (!handle) return
      deviceWidth = info.codedSize.width
      deviceHeight = info.codedSize.height
      const content = info.contentRect
      damage = { x: content.x, y: content.y, width: content.width, height: content.height }
      source = { kind: 'texture', handle, swapRB: info.pixelFormat !== 'rgba' }
      // Label it loudly: the shared texture disables damage tracking, so this mode sends a full
      // frame every time. It is the right choice only for content that changes everywhere.
      this.metrics.path = 'iosurface(FULL)'
    } else {
      if (image.isEmpty()) return
      const bitmap = image.toBitmap()
      const logical = image.getSize()
      deviceWidth = logical.width
      deviceHeight = logical.height
      if (bitmap.length !== deviceWidth * deviceHeight * 4) return
      damage = { x: dirty.x, y: dirty.y, width: dirty.width, height: dirty.height }
      source = { kind: 'bitmap', bitmap, stride: deviceWidth * 4, swapRB: true }
      this.metrics.path = 'bitmap'
    }

    // Chromium's surface only has to COVER the terminal; anything past the edge is simply not
    // placed. Requiring an exact match meant one rounding pixel froze rendering permanently.
    if (deviceWidth < surface.width || deviceHeight < surface.height) {
      this.accumulate(surface, damage)
      return
    }

    const viewWidth = surface.width
    const viewHeight = surface.height
    const tile = this.tileSize()
    const tiler = surface.ensureTiler(this.geo.cellWidth, this.geo.cellHeight, tile.cols, tile.rows)

    // Replay anything a skipped frame left behind.
    if (surface.pendingDamage) {
      damage = unionRect(surface.pendingDamage, damage)
      surface.pendingDamage = null
    }
    damage = clampRect(damage, viewWidth, viewHeight)
    if (damage.width <= 0 || damage.height <= 0) return

    // Chromium's dirty rect is the union of every change, so it over-reports whenever more than
    // one region moves. Use it only to narrow the search, then hash those tiles to find the ones
    // whose pixels actually differ from what we last sent.
    const candidates = this.mode.strategy === 'tile' ? tiler.intersecting(damage) : []
    if (this.dumpPending && DUMP_SOURCE) {
      this.dumpPending = false
      const full = { x: 0, y: 0, width: viewWidth, height: viewHeight }
      this.copyInto(source, full, surface.fullBuffer)
      try {
        writeFileSync(DUMP_SOURCE, surface.fullBuffer)
        appendFileSync(`${DUMP_SOURCE}.meta`, `${viewWidth}x${viewHeight}\n`)
      } catch (err) {
        appendFileSync('/tmp/et-error.log', `${new Date().toISOString()} dump failed: ${String(err)}\n`)
      }
      return // do not transmit: the terminal must already show this content
    }

    const damaged = this.native ? this.filterChanged(surface, candidates, source) : candidates
    const widespread =
      this.mode.strategy === 'tile' && damaged.length / tiler.tiles.length > FULL_FRAME_THRESHOLD
    const useFull = this.mode.strategy === 'full' || surface.needsFullFrame || widespread

    const frameStart = performance.now()
    this.frameSeq++
    let escapes = ''
    let bytes = 0
    let convertMs = 0
    let encodeMs = 0
    let tileCount = 0

    if (useFull) {
      // Retire the ENTIRE tile id range, not just the tiles we believe we placed. At equal z the
      // higher image id composites on top, and tiles use ids 2+ while the full frame uses id 1, so
      // any tile we have lost track of — across a window swap, a resize, or a delete the terminal
      // did not honour — keeps floating above a perfectly correct full frame forever. Bookkeeping
      // is exactly what is unreliable here, so do not depend on it: ~3KB of deletes against an
      // 11MB frame is not worth being clever about.
      let retire = ''
      if (surface.tilesMayBePlaced) {
        for (let i = 0; i < tiler.tiles.length; i++) retire += deleteImage(surface.tileId(i))
        surface.tilesMayBePlaced = false
      }

      const region = { x: 0, y: 0, width: viewWidth, height: viewHeight }
      const emitted = this.emitRegion(
        surface.fullFrameId,
        region,
        surface.colOffset,
        surface.rowOffset,
        source,
        surface.fullBuffer,
        true,
      )
      escapes = retire + emitted.escapes
      bytes = emitted.bytes
      convertMs = emitted.convertMs
      encodeMs = emitted.encodeMs
      tileCount = 1
      surface.needsFullFrame = false
      surface.placedTiles.clear()
      // Record what the full frame just put on screen. Zeroing instead would make every tile look
      // changed next frame, forcing another full frame — a loop that defeats damage tracking.
      this.rehashAll(surface, source)
      if (widespread) this.metrics.count('fullFrameFallbacks')
    } else {
      if (damaged.length === 0) return
      for (const tile of damaged) {
        const emitted = this.emitTile(surface, tile, source)
        escapes += emitted.escapes
        bytes += emitted.bytes
        convertMs += emitted.convertMs
        encodeMs += emitted.encodeMs
      }
      tileCount = damaged.length
    }

    const tWrite = performance.now()
    // One write, bracketed as a single atomic update: the terminal must not present a frame that
    // is half old tiles and half new ones.
    const framed = ATOMIC_FRAMES ? BEGIN_FRAME + escapes + END_FRAME : escapes
    if (!process.stdout.write(framed)) this.draining = true
    const writeMs = performance.now() - tWrite

    this.record(performance.now() - frameStart, convertMs, encodeMs, writeMs, bytes, tileCount)
    this.fullFrameRatio += (Number(useFull) - this.fullFrameRatio) * 0.05
    // The status line costs three percentile computations, each of which sorts the sample window.
    // At frame rate that is more expensive than the frame itself, and nobody can read 60 updates a
    // second anyway, so redraw it at 4 Hz.
    const now = performance.now()
    if (this.hudLevel > 0 && now - this.lastHudAt >= HUD_INTERVAL_MS) {
      this.lastHudAt = now
      this.drawHud()
    }
  }

  private emitTile(surface: Surface, tile: Tile, source: PixelSource): {
    escapes: string
    bytes: number
    convertMs: number
    encodeMs: number
  } {
    // Stable id per tile: delete then re-transmit at the same cell so the replacement always
    // covers exactly what it replaced and no stale hole can appear.
    const id = surface.tileId(tile.index)
    const seen = surface.placedTiles.has(tile.index)
    surface.placedTiles.add(tile.index)
    surface.tilesMayBePlaced = true
    const region = { x: tile.x, y: tile.y, width: tile.width, height: tile.height }
    return this.emitRegion(
      id,
      region,
      surface.colOffset + tile.col,
      surface.rowOffset + tile.row,
      source,
      tile.buffer,
      seen,
    )
  }

  /** Convert one region out of the frame and produce the escapes that display it. */
  private emitRegion(
    id: number,
    region: Rect,
    col: number,
    row: number,
    source: PixelSource,
    scratch: Buffer,
    deleteFirst: boolean,
  ): { escapes: string; bytes: number; convertMs: number; encodeMs: number } {
    const transport = this.effectiveTransport()
    const native = this.native
    const prefix = (deleteFirst ? deleteImage(id) : '') + cursorTo(col, row)

    if (transport === 'shm' && native) {
      // The pixels are converted directly into shared memory inside the addon: no JS copy at all.
      const name = `/et${process.pid % 100000}-${this.shmSeq++ % SHM_NAME_SPACE}`
      const t0 = performance.now()
      const result =
        source.kind === 'texture'
          ? native.shmFromIOSurface(
              source.handle,
              region.x,
              region.y,
              region.width,
              region.height,
              name,
              source.swapRB,
              PACK_RGB,
            )
          : native.shmFromBitmap(
              source.bitmap,
              source.stride,
              region.x,
              region.y,
              region.width,
              region.height,
              name,
              source.swapRB,
              PACK_RGB,
            )
      const convertMs = performance.now() - t0
      const t1 = performance.now()
      const escapes = placeShm(id, region.width, region.height, name, PACK_RGB ? 24 : 32)
      this.pendingShm.push({ name, bytes: result.bytes, frame: this.frameSeq })
      this.pendingShmBytes += result.bytes
      // Reclaim by AGE IN FRAMES, never by object count. A frame that damages hundreds of tiles
      // creates hundreds of objects at once, and counting objects would reclaim ones belonging to
      // the frame currently being transmitted.
      while (this.pendingShm.length > 0) {
        const oldest = this.pendingShm[0]
        if (oldest === undefined) break
        const age = this.frameSeq - oldest.frame
        // Too young to touch: the terminal may not have mapped it yet.
        if (age < SHM_MIN_FRAMES) break
        // Otherwise reclaim once it is simply old, or early if a burst blew the byte budget.
        if (age < SHM_MAX_FRAMES && this.pendingShmBytes <= SHM_BYTES_BUDGET) break
        this.pendingShm.shift()
        this.pendingShmBytes -= oldest.bytes
        native.unlinkShm(oldest.name)
      }
      return { escapes: prefix + escapes, bytes: result.bytes, convertMs, encodeMs: performance.now() - t1 }
    }

    const t0 = performance.now()
    this.copyInto(source, region, scratch)
    const convertMs = performance.now() - t0
    const t1 = performance.now()
    const sent = placeInline(id, region.width, region.height, scratch.subarray(0, region.width * region.height * 4))
    return { escapes: prefix + sent.escapes, bytes: sent.bytes, convertMs, encodeMs: performance.now() - t1 }
  }

  private copyInto(source: PixelSource, region: Rect, dst: Buffer): void {
    const native = this.native
    if (source.kind === 'texture') {
      if (!native) throw new Error('texture source requires the native addon')
      native.copyIOSurface(source.handle, region.x, region.y, region.width, region.height, dst, source.swapRB)
      return
    }
    if (native) {
      native.convertRect(
        source.bitmap,
        source.stride,
        region.x,
        region.y,
        region.width,
        region.height,
        dst,
        source.swapRB,
      )
      return
    }
    const s32 = new Uint32Array(source.bitmap.buffer, source.bitmap.byteOffset, source.bitmap.byteLength >>> 2)
    const d32 = new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >>> 2)
    const srcWidth = source.stride >>> 2
    let d = 0
    for (let y = 0; y < region.height; y++) {
      let sIdx = (region.y + y) * srcWidth + region.x
      const end = sIdx + region.width
      for (; sIdx < end; sIdx++, d++) {
        const v = s32[sIdx] as number
        d32[d] = (v & 0xff00ff00) | ((v & 0x00ff0000) >>> 16) | ((v & 0x000000ff) << 16)
      }
    }
  }

  /** The live webContents, counting how often input had nowhere to go. */
  private windowContents(): Electron.WebContents | null {
    const w = this.window
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) {
      this.metrics.count('inputUndelivered')
      return null
    }
    return w.webContents
  }

  /** After a full-frame upload, remember the content hash of every tile. */
  private rehashAll(surface: Surface, source: PixelSource): void {
    const native = this.native
    const tiler = surface.tiler
    if (!native || !tiler) return
    const rects = surface.candidateRects
    const hashes = surface.candidateHashes
    if (rects.length < tiler.tiles.length * 4) return
    for (let i = 0; i < tiler.tiles.length; i++) {
      const t = tiler.tiles[i]
      if (!t) return
      rects[i * 4] = t.x
      rects[i * 4 + 1] = t.y
      rects[i * 4 + 2] = t.width
      rects[i * 4 + 3] = t.height
    }
    const view = rects.subarray(0, tiler.tiles.length * 4)
    try {
      if (source.kind === 'texture') native.hashTilesIOSurface(source.handle, view, hashes)
      else native.hashTilesBitmap(source.bitmap, source.stride, view, hashes)
    } catch {
      surface.tileHashes.fill(0)
      return
    }
    for (let i = 0; i < tiler.tiles.length; i++) {
      const t = tiler.tiles[i]
      if (t) surface.tileHashes[t.index] = hashes[i] ?? 0
    }
  }

  /** Narrow a set of candidate tiles to those whose pixel content actually changed. */
  private filterChanged(surface: Surface, candidates: Tile[], source: PixelSource): Tile[] {
    const native = this.native
    if (!native || candidates.length === 0) return candidates
    const rects = surface.candidateRects
    const hashes = surface.candidateHashes
    if (rects.length < candidates.length * 4) return candidates

    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i]
      if (!t) return candidates
      rects[i * 4] = t.x
      rects[i * 4 + 1] = t.y
      rects[i * 4 + 2] = t.width
      rects[i * 4 + 3] = t.height
    }
    const view = rects.subarray(0, candidates.length * 4)
    try {
      if (source.kind === 'texture') native.hashTilesIOSurface(source.handle, view, hashes)
      else native.hashTilesBitmap(source.bitmap, source.stride, view, hashes)
    } catch {
      return candidates // hashing is an optimisation; never let it break a frame
    }

    const changed: Tile[] = []
    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i]
      if (!t) continue
      const hash = hashes[i] ?? 0
      if (hash !== 0 && surface.tileHashes[t.index] === hash) continue
      surface.tileHashes[t.index] = hash
      changed.push(t)
    }
    return changed
  }

  private accumulate(surface: Surface, rect: Rect): void {
    surface.pendingDamage = surface.pendingDamage ? unionRect(surface.pendingDamage, rect) : rect
  }

  /** What is actually in use, which is not always what was asked for. */
  private effectiveModeName(): string {
    const requested = this.mode.transport
    const actual = this.effectiveTransport()
    const label = `${this.mode.strategy}-${actual}`
    return actual === requested ? label : `${label}(fallback from ${requested})`
  }

  private record(frameMs: number, copyMs: number, encodeMs: number, writeMs: number, bytes: number, tiles: number): void {
    this.metrics.mode = this.effectiveModeName()
    this.metrics.focused = this.focused
    this.metrics.recordFrame(frameMs, copyMs, encodeMs, writeMs, bytes, tiles)
  }

  private drawHud(): void {
    if (!this.geo) return
    const m = this.metrics
    const fps = m.fpsWindow
    const p50 = m.frame.percentile(50)
    const p95 = m.frame.percentile(95)
    const bytes = m.bytes.percentile(50)
    const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`
    const warn =
      `${m.get('inputUndelivered') > 0 ? ` · UNDELIVERED ${m.get('inputUndelivered')}` : ''}` +
      `${m.get('inputErrors') > 0 ? ` · ERR ${m.get('inputErrors')} ${this.lastInputError}` : ''}` +
      `${this.term.recoveries > 0 ? ` · recovered ${this.term.recoveries}` : ''}`
    const line =
      this.hudLevel === 1
        ? `${fps.toFixed(0)}fps${this.focused ? '' : ' (bg)'} · p50 ${p50.toFixed(2)} p95 ${p95.toFixed(2)}ms · ${size}/frame · ${m.path}${warn} · ctrl+h`
        : // Health first, detail second: the line is truncated to the grid width, so anything
          // that can be cut must be detail. Losing "err 3" off the end hides the one thing worth
          // seeing.
          `${fps.toFixed(0)}fps [${this.effectiveModeName()}/${m.path}] ` +
          `p50 ${p50.toFixed(2)} p95 ${p95.toFixed(2)} max ${m.frame.max.toFixed(1)}ms ${size} ` +
          `full ${(this.fullFrameRatio * 100).toFixed(0)}% drop ${m.get('dropped')} undeliv ${m.get('inputUndelivered')} err ${m.get('inputErrors')} ` +
          `recov ${this.term.recoveries}/${this.term.rawRestores} fb ${m.get('fullFrameFallbacks')}${this.devtoolsOpen ? ` devtools:${this.dock}` : ''} ` +
          `| tiles ${m.tiles.percentile(50).toFixed(0)} gap ${m.interval.percentile(95).toFixed(1)} ` +
          `cp ${m.copy.percentile(50).toFixed(2)} en ${m.encode.percentile(50).toFixed(2)} wr ${m.write.percentile(50).toFixed(2)} ` +
          `in ${m.get('inputEvents')} ${((performance.now() - this.lastInputAt) / 1000).toFixed(1)}s ${this.lastInputKind} ` +
          `rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}M shm ${(this.pendingShmBytes / 1048576).toFixed(0)}M`
    this.term.hud(this.geo.rows, line, this.geo.cols)
  }

  /** Append one metrics sample as a JSON line. The final line carries `final: true`. */
  private emitMetrics(final: boolean): void {
    if (!METRICS_PATH) return
    const snapshot = {
      ...this.metrics.snapshot(this.pendingShmBytes, this.pendingShm.length),
      final,
      scenario: SCENARIO ?? 'default',
      texture: this.useTexture,
      frameRateCap: FRAME_RATE,
      geometry: this.geo ? { px: [this.geo.pxWidth, this.geo.pxHeight], cells: [this.geo.cols, this.geo.rows] } : null,
      capabilities: this.capabilities,
    }
    try {
      appendFileSync(METRICS_PATH, `${JSON.stringify(snapshot)}\n`)
    } catch {
      /* a metrics write must never take the render loop down */
    }
  }

  /** Run a context-menu action chosen in the page. */
  runMenuAction(action: string): void {
    const wc = this.windowContents()
    if (!wc) return
    switch (action) {
      case 'undo': wc.undo(); break
      case 'redo': wc.redo(); break
      case 'cut': wc.cut(); break
      case 'copy': wc.copy(); break
      case 'paste': wc.paste(); break
      case 'selectAll': wc.selectAll(); break
      case 'reload': wc.reload(); this.page.needsFullFrame = true; break
      case 'copyLink': wc.copy(); break
      default: break
    }
    // Copy must reach the terminal's clipboard too, or it only exists inside Chromium.
    if (action === 'copy' || action === 'cut' || action === 'copyLink') {
      setTimeout(() => void this.syncClipboardToTerminal(), 40)
    }
  }

  /** Push Chromium's clipboard into the terminal's clipboard with OSC 52. */
  private async syncClipboardToTerminal(): Promise<void> {
    try {
      const text = await clipboard.readText()
      if (!text || this.disposed) return
      const encoded = Buffer.from(text, 'utf8').toString('base64')
      this.term.write(`\x1b]52;c;${encoded}\x07`)
    } catch {
      /* clipboard access is best effort */
    }
  }

  private setCursor(type: string): void {
    const map: Readonly<Record<string, string>> = {
      pointer: 'pointer',
      hand: 'pointer',
      text: 'text',
      'north-south-resize': 'ns-resize',
      'east-west-resize': 'ew-resize',
      default: 'default',
    }
    this.term.write(`\x1b]22;${map[type] ?? 'default'}\x1b\\`)
  }

  // ---------- input ----------

  private onInput(chunk: Buffer): void {
    if (this.disposed) return
    if (process.env['ET_DEBUG_INPUT']) {
      appendFileSync('/tmp/et-input.log', `${JSON.stringify(chunk.toString('latin1'))}\n`)
    }
    this.lastInputAt = performance.now()
    let events: TermEvent[]
    try {
      events = this.parser.push(chunk)
    } catch (err) {
      this.noteInputError('parse', err)
      return
    }
    // Coalesce mouse motion. A drag reports far faster than we can paint, and dispatching every
    // move synchronously turns one input chunk into hundreds of IPC round trips that block the
    // main process — paints queue behind them and the drag visibly lags. Only the newest position
    // matters, so keep the last move in each run and drop the rest.
    const coalesced: TermEvent[] = []
    for (const ev of events) {
      this.metrics.count('inputEvents')
      const previous = coalesced[coalesced.length - 1]
      if (
        ev.kind === 'mouse' &&
        ev.action === 'move' &&
        previous !== undefined &&
        previous.kind === 'mouse' &&
        previous.action === 'move'
      ) {
        this.metrics.count('inputCoalesced')
        coalesced[coalesced.length - 1] = ev
        continue
      }
      coalesced.push(ev)
    }

    for (const ev of coalesced) {
      this.lastInputKind =
        ev.kind === 'mouse'
          ? `${ev.action}:${ev.button}@${ev.x},${ev.y}`
          : ev.kind === 'paste'
            ? `paste:${ev.text.length}`
            : ev.kind === 'focus'
              ? `focus:${ev.focused}`
              : `key:${ev.named ?? String.fromCodePoint(ev.code || 63)}`
      // One throw here used to abort the loop and, because every later chunk threw the same way,
      // strand input permanently while frames kept flowing. Never let dispatch kill the loop.
      try {
        if (ev.kind === 'mouse') this.onMouse(ev)
        else if (ev.kind === 'paste') this.onPaste(ev.text)
        else if (ev.kind === 'focus') this.onFocus(ev.focused)
        else if (!this.handleControlKey(ev)) this.onKey(ev)
      } catch (err) {
        this.noteInputError(ev.kind, err)
      }
    }
  }

  private noteInputError(where: string, err: unknown): void {
    this.metrics.count('inputErrors')
    this.lastInputError = `${where}: ${(err as Error).message ?? String(err)}`.slice(0, 60)
    appendFileSync('/tmp/et-error.log', `${new Date().toISOString()} ${where} ${String(err)}\n`)
  }

  private handleControlKey(ev: KeyEvent): boolean {
    if (!ev.ctrl || ev.action === 'release') return false
    const char = ev.code >= 32 ? String.fromCodePoint(ev.code) : ''
    switch (char) {
      case 'q':
      case 'c':
        this.quit()
        return true
      case 'h': {
        const wasVisible = this.hudLevel > 0
        this.hudLevel = (this.hudLevel + 1) % 3
        if (this.hudLevel === 0 && this.geo) this.term.hud(this.geo.rows, '', this.geo.cols)
        // Showing or hiding the line changes how many rows the surfaces get.
        if (this.geo && wasVisible !== this.hudLevel > 0) {
          this.layoutSurfaces(this.geo)
          this.resetSurfaces()
          this.resizeWindows(this.geo)
        }
        return true
      }
      case 'r':
        this.window?.webContents.reload()
        this.page.needsFullFrame = true
        return true
      case 't':
        this.useTexture = !this.useTexture
        this.recreateWindow()
        return true
      case 'i':
        this.toggleDevtools()
        return true
      case 'o':
        this.cycleDock()
        return true
      case 'p':
        // Dump the next painted frame as ground truth for the visual test.
        if (DUMP_SOURCE) {
          this.dumpPending = true
          const wc = this.windowContents()
          // invalidate() does not force a paint when the shared texture is in use; cycling the
          // offscreen painter does, in both modes.
          wc?.invalidate()
          wc?.stopPainting()
          wc?.startPainting()
        }
        return true
      case '1':
      case '2':
      case '3':
      case '4':
        this.modeIndex = Number(char) - 1
        // tile size follows the transport, so the tilers must be rebuilt
        this.page.tiler = null
        this.devtools.tiler = null
        this.resetSurfaces()
        return true
      default:
        return false
    }
  }

  private resetSurfaces(): void {
    this.term.write('\x1b_Ga=d,d=A,q=2\x1b\\')
    // The delete above may not have been honoured; assume every tile is still on screen.
    this.page.reset()
    this.devtools.reset()
  }

  /**
   * Swap the window (the only way to change useSharedTexture). Create the replacement BEFORE
   * destroying the old one: a moment with zero windows lets Electron fire `window-all-closed`,
   * which used to call quit() and set `disposed`, and `this.window` being null silently drops
   * every input event while paints from the old window keep arriving — input dead, frames fine.
   * Destroying on the next tick also avoids tearing down a window inside its own input callback.
   */
  private recreateWindow(): void {
    if (!this.geo) return
    const old = this.window
    this.resetSurfaces()
    this.page.tiler = null
    this.createWindow(this.geo)
    this.metrics.count('windowSwaps')
    if (old) {
      setImmediate(() => {
        if (!old.isDestroyed()) old.destroy()
      })
    }
  }

  hasWindow(): boolean {
    return this.page.isLive() || this.devtools.isLive()
  }

  private onMouse(ev: TermMouseEvent): void {
    // Route to whichever surface the pointer is over, and translate into that window's space.
    const surface = this.devtoolsOpen && this.devtools.contains(ev.x, ev.y) ? this.devtools : this.page
    if (!surface.isLive()) {
      this.metrics.count('inputUndelivered')
      return
    }
    const wc = surface.window?.webContents
    if (!wc) {
      this.metrics.count('inputUndelivered')
      return
    }
    if (ev.action === 'down') this.focusedSurface = surface
    const x = Math.round((ev.x - surface.originX) / this.scale)
    const y = Math.round((ev.y - surface.originY) / this.scale)
    const modifiers: Modifier[] = []
    if (ev.shift) modifiers.push('shift')
    if (ev.ctrl) modifiers.push('control')
    if (ev.alt) modifiers.push('alt')

    if (ev.action === 'wheel') {
      wc.sendInputEvent({
        type: 'mouseWheel',
        x,
        y,
        deltaX: ev.wheelX * 80,
        deltaY: ev.wheelY * 80,
        canScroll: true,
        modifiers,
      })
      return
    }
    if (ev.action === 'move') {
      wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers })
      return
    }

    // Back/forward have no Electron mouse button; drive history directly.
    if (ev.button === 'back' || ev.button === 'forward') {
      if (ev.action !== 'down') return
      const history = wc.navigationHistory
      if (ev.button === 'back' && history.canGoBack()) history.goBack()
      if (ev.button === 'forward' && history.canGoForward()) history.goForward()
      return
    }

    if (ev.action === 'down' && surface.window && !surface.window.isDestroyed()) {
      surface.window.focusOnWebView()
    }
    if (ev.action === 'down') {
      // Terminals do not report click counts, so double and triple clicks have to be inferred
      // from timing and distance. Without this, double-click-to-select-a-word never works.
      const now = performance.now()
      const near = Math.abs(x - this.lastClickX) < 4 && Math.abs(y - this.lastClickY) < 4
      this.clickCount = now - this.lastClickAt < 500 && near ? Math.min(this.clickCount + 1, 3) : 1
      this.lastClickAt = now
      this.lastClickX = x
      this.lastClickY = y
    }

    wc.sendInputEvent({
      type: ev.action === 'down' ? 'mouseDown' : 'mouseUp',
      x,
      y,
      button: ev.button,
      clickCount: this.clickCount,
      modifiers,
    })

    // Chromium raises the contextmenu event from a dedicated input event, not from a right-click.
    if (ev.action === 'up' && ev.button === 'right') {
      wc.sendInputEvent({ type: 'contextMenu', x, y, button: 'right', modifiers })
    }
  }

  private onPaste(text: string): void {
    this.windowContents()?.insertText(text)
  }

  private onFocus(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    if (!focused && UNFOCUSED_FRAME_RATE === 0) {
      this.window?.webContents.setFrameRate(1)
      this.paused = true
      this.metrics.count('paused')
      return
    }
    this.paused = false
    // An unfocused terminal is not being looked at. Dropping to 1fps stops Chromium rasterizing,
    // stops our copies, and stops Ghostty decoding and uploading textures for nobody.
    this.window?.webContents.setFrameRate(focused ? FRAME_RATE : UNFOCUSED_FRAME_RATE)
    if (focused) {
      // Mirror the terminal's focus so the caret blinks when the user is actually there.
      if (this.window && !this.window.isDestroyed()) this.window.focusOnWebView()
      this.page.needsFullFrame = true
      this.devtools.needsFullFrame = true
    }
  }

  private onKey(ev: KeyEvent): void {
    // Keys go to whichever surface was last clicked.
    const target = this.focusedSurface.isLive() ? this.focusedSurface : this.page
    const wc = target.window?.webContents
    if (!wc) {
      this.metrics.count('inputUndelivered')
      return
    }
    const modifiers: Modifier[] = []
    if (ev.shift) modifiers.push('shift')
    if (ev.ctrl) modifiers.push('control')
    if (ev.alt) modifiers.push('alt')
    if (ev.meta) modifiers.push('meta')

    const keyCode = ev.named ?? (ev.code > 0 ? String.fromCodePoint(ev.code) : null)
    if (!keyCode) return
    // With kitty keyboard flags 1|2|8|16 the terminal reports real press/repeat/release, so we
    // no longer synthesize a keyUp after every keyDown — held keys now behave like held keys.
    if (ev.action === 'release') {
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      return
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (ev.text && !ev.ctrl && !ev.alt && !ev.meta) {
      wc.sendInputEvent({ type: 'char', keyCode: ev.text, modifiers })
    }
  }

  // ---------- lifecycle ----------

  private async onResize(): Promise<void> {
    // SIGWINCH fires repeatedly while a window is dragged. Overlapping geometry queries would
    // race for the same reply bytes and one of them would never resolve.
    if (this.disposed || this.resizing) return
    this.resizing = true
    try {
      const probe = await this.term.probe()
      this.geo = probe.geometry
      this.metrics.count('resizes')
    } catch {
      this.resizing = false
      return
    }
    this.resizing = false
    this.term.reassertModes()
    const geo = this.geo
    if (!geo) return
    this.layoutSurfaces(geo)
    this.resetSurfaces()
    this.page.tiler = null
    this.devtools.tiler = null
    this.resizeWindows(geo)
  }

  quit(): void {
    if (this.disposed) return
    this.disposed = true
    this.emitMetrics(true)
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    if (this.modeTimer) clearInterval(this.modeTimer)
    this.term.disable()
    for (const entry of this.pendingShm) this.native?.unlinkShm(entry.name)
    this.pendingShm.length = 0
    this.pendingShmBytes = 0
    for (const surface of [this.devtools, this.page]) {
      const win = surface.window
      surface.window = null
      if (win && !win.isDestroyed()) win.destroy()
    }
    app.quit()
  }
}

if (DEVTOOLS_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', DEVTOOLS_PORT)
}
// Quieten Chromium's own logging; what remains is redirected to a file once rendering starts.
app.commandLine.appendSwitch('disable-logging')

process.on('uncaughtException', (err: Error) => {
  appendFileSync('/tmp/et-error.log', `${new Date().toISOString()} uncaught ${err.stack ?? err.message}\n`)
})

const bridge = new Bridge()
ipcMain.on('term:menu-action', (_event, action: unknown) => {
  if (typeof action === 'string') bridge.runMenuAction(action)
})
// NOTE: do NOT set --disable-frame-rate-limit. Measured 2026-08-27: it makes the offscreen renderer
// report the whole window dirty on ~99.6% of paints (5302/5321) and emit ~890 paints/sec, which
// destroys damage tracking. Without it, 3/714 paints are full-frame.
app.whenReady().then(
  () => {
    if (!loadNative()) {
      process.stderr.write(`browser-in-terminal: native addon unavailable (${nativeLoadError() ?? 'unknown'}), falling back to JS + base64\n`)
    }
    return bridge.start()
  },
  (err: unknown) => {
    process.stderr.write(`browser-in-terminal: failed to start: ${String(err)}\n`)
    app.exit(1)
  },
)
app.on('window-all-closed', () => {
  // Not during a deliberate window swap — recreateWindow() always leaves a live window behind.
  if (!bridge.hasWindow()) bridge.quit()
})
