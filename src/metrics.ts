/**
 * Measurement for the render pipeline.
 *
 * Last-frame numbers are not a measurement — they hide the tail, and the tail is what a user
 * feels. Everything here is a bounded-memory histogram so we can report p50/p95/p99/max, plus
 * counters for the events that matter operationally (drops, fallbacks, errors, recoveries).
 */

/** Fixed-capacity sample ring. Recording is O(1) and allocation-free; percentiles are computed on demand. */
export class Histogram {
  private readonly samples: Float64Array
  private index = 0
  private filled = 0
  private total = 0
  private minimum = Number.POSITIVE_INFINITY
  private maximum = Number.NEGATIVE_INFINITY

  constructor(capacity = 8192) {
    this.samples = new Float64Array(capacity)
  }

  record(value: number): void {
    if (!Number.isFinite(value)) return
    this.samples[this.index] = value
    this.index = (this.index + 1) % this.samples.length
    if (this.filled < this.samples.length) this.filled++
    this.total += value
    if (value < this.minimum) this.minimum = value
    if (value > this.maximum) this.maximum = value
  }

  get count(): number {
    return this.filled
  }

  get mean(): number {
    return this.filled === 0 ? 0 : this.total / this.filled
  }

  get min(): number {
    return this.filled === 0 ? 0 : this.minimum
  }

  get max(): number {
    return this.filled === 0 ? 0 : this.maximum
  }

  /** Nearest-rank percentile over the retained window. */
  percentile(p: number): number {
    if (this.filled === 0) return 0
    const window = this.samples.slice(0, this.filled)
    window.sort()
    const rank = Math.min(this.filled - 1, Math.max(0, Math.ceil((p / 100) * this.filled) - 1))
    return window[rank] ?? 0
  }

  summary(): StatSummary {
    return {
      count: this.count,
      mean: round(this.mean),
      p50: round(this.percentile(50)),
      p95: round(this.percentile(95)),
      p99: round(this.percentile(99)),
      max: round(this.max),
    }
  }

  reset(): void {
    this.index = 0
    this.filled = 0
    this.total = 0
    this.minimum = Number.POSITIVE_INFINITY
    this.maximum = Number.NEGATIVE_INFINITY
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

export interface StatSummary {
  count: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface MetricsSnapshot {
  /** seconds since the metrics were created */
  uptime: number
  mode: string
  path: string
  focused: boolean
  /** frames actually presented per second, over the whole run */
  fps: number
  /** instantaneous fps over the last window */
  fpsWindow: number
  timings: {
    /** wall time from paint callback entry to the write() returning */
    frame: StatSummary
    /** pixel conversion (and, for shm, the write into shared memory) */
    copy: StatSummary
    /** protocol encoding: zlib+base64, or building the shm escape */
    encode: StatSummary
    /** the write() to the pty, which blocks when the terminal cannot keep up */
    write: StatSummary
    /** interval between presented frames: the honest measure of smoothness */
    interval: StatSummary
  }
  bytes: {
    perFrame: StatSummary
    totalMiB: number
    /** average bytes per second pushed at the terminal */
    rateMiBs: number
  }
  tiles: StatSummary
  counters: Record<string, number>
  memory: {
    rssMiB: number
    externalMiB: number
    /** shared-memory objects still awaiting the terminal */
    shmPendingMiB: number
    shmPendingCount: number
  }
}

export type CounterName =
  | 'frames'
  | 'dropped'
  | 'paused'
  | 'fullFrameFallbacks'
  | 'inputEvents'
  | 'inputCoalesced'
  | 'inputErrors'
  | 'inputUndelivered'
  | 'inputRecoveries'
  | 'resizes'
  | 'windowSwaps'

export class Metrics {
  readonly frame = new Histogram()
  readonly copy = new Histogram()
  readonly encode = new Histogram()
  readonly write = new Histogram()
  readonly interval = new Histogram()
  readonly bytes = new Histogram()
  readonly tiles = new Histogram()

  private readonly counters = new Map<CounterName, number>()
  private readonly startedAt = performance.now()
  /** Rates are measured from here, so warmup frames do not pollute the steady-state numbers. */
  private baselineAt = performance.now()
  private baselineFrames = 0
  private lastFrameAt = 0
  private totalBytes = 0
  private windowStart = performance.now()
  private windowFrames = 0
  private windowFps = 0

  mode = '-'
  path = '-'
  focused = true

  count(name: CounterName, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  get(name: CounterName): number {
    return this.counters.get(name) ?? 0
  }

  /** Record one presented frame. `frameMs` is the whole paint-to-write span. */
  recordFrame(frameMs: number, copyMs: number, encodeMs: number, writeMs: number, bytes: number, tiles: number): void {
    const now = performance.now()
    if (this.lastFrameAt !== 0) this.interval.record(now - this.lastFrameAt)
    this.lastFrameAt = now

    this.frame.record(frameMs)
    this.copy.record(copyMs)
    this.encode.record(encodeMs)
    this.write.record(writeMs)
    this.bytes.record(bytes)
    this.tiles.record(tiles)
    this.totalBytes += bytes
    this.count('frames')

    this.windowFrames++
    const elapsed = now - this.windowStart
    if (elapsed >= 500) {
      this.windowFps = (this.windowFrames * 1000) / elapsed
      this.windowFrames = 0
      this.windowStart = now
    }
  }

  get fpsWindow(): number {
    return this.windowFps
  }

  snapshot(shmPendingBytes: number, shmPendingCount: number): MetricsSnapshot {
    const uptime = (performance.now() - this.startedAt) / 1000
    const measured = Math.max((performance.now() - this.baselineAt) / 1000, 0.001)
    const measuredFrames = this.get('frames') - this.baselineFrames
    const memory = process.memoryUsage()
    const counters: Record<string, number> = {}
    for (const [k, v] of this.counters) counters[k] = v
    return {
      uptime: round(uptime),
      mode: this.mode,
      path: this.path,
      focused: this.focused,
      fps: round(measuredFrames / measured),
      fpsWindow: round(this.windowFps),
      timings: {
        frame: this.frame.summary(),
        copy: this.copy.summary(),
        encode: this.encode.summary(),
        write: this.write.summary(),
        interval: this.interval.summary(),
      },
      bytes: {
        perFrame: this.bytes.summary(),
        totalMiB: round(this.totalBytes / 1048576),
        rateMiBs: round(this.totalBytes / 1048576 / measured),
      },
      tiles: this.tiles.summary(),
      counters,
      memory: {
        rssMiB: round(memory.rss / 1048576),
        externalMiB: round(memory.external / 1048576),
        shmPendingMiB: round(shmPendingBytes / 1048576),
        shmPendingCount: shmPendingCount,
      },
    }
  }

  /** Drop the retained samples but keep cumulative counters — used to time a specific scenario. */
  resetTimings(): void {
    for (const h of [this.frame, this.copy, this.encode, this.write, this.interval, this.bytes, this.tiles]) {
      h.reset()
    }
    this.lastFrameAt = 0
    this.baselineAt = performance.now()
    this.baselineFrames = this.get('frames')
    this.totalBytes = 0
  }
}
