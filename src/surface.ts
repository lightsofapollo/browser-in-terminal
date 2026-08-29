/**
 * A surface is one Chromium window occupying a rectangle of the terminal.
 *
 * There are two: the page, and (optionally) DevTools beside it. Each keeps its own tiler, tile
 * hashes and placement bookkeeping, because damage is per-window; and each owns a distinct range
 * of kitty image ids, because at equal z the higher id composites on top and two surfaces sharing
 * ids would draw over each other.
 */

import type { BrowserWindow } from 'electron'

import { Tiler, type Rect } from './framebuffer.js'

/** Image ids reserved per surface. Tiles are idBase+2.., the full frame is idBase+1. */
export const SURFACE_ID_STRIDE = 4096

export class Surface {
  tiler: Tiler | null = null
  fullBuffer: Buffer = Buffer.alloc(0)
  tileHashes = new Float64Array(0)
  candidateRects = new Int32Array(0)
  candidateHashes = new Float64Array(0)
  readonly placedTiles = new Set<number>()
  tilesMayBePlaced = true
  needsFullFrame = true
  pendingDamage: Rect | null = null

  /** Position and size within the terminal, in device pixels and in cells. */
  originX = 0
  originY = 0
  width = 0
  height = 0
  colOffset = 0
  rowOffset = 0

  constructor(
    readonly index: number,
    public window: BrowserWindow | null,
  ) {}

  get idBase(): number {
    return this.index * SURFACE_ID_STRIDE
  }

  get fullFrameId(): number {
    return this.idBase + 1
  }

  tileId(tileIndex: number): number {
    return this.idBase + 2 + tileIndex
  }

  /** True when a device-pixel point falls inside this surface. */
  contains(x: number, y: number): boolean {
    return x >= this.originX && x < this.originX + this.width && y >= this.originY && y < this.originY + this.height
  }

  place(originX: number, originY: number, width: number, height: number, colOffset: number, rowOffset: number): void {
    if (originX === this.originX && originY === this.originY && width === this.width && height === this.height) {
      return
    }
    this.originX = originX
    this.originY = originY
    this.width = width
    this.height = height
    this.colOffset = colOffset
    this.rowOffset = rowOffset
    this.tiler = null
    this.needsFullFrame = true
  }

  ensureTiler(cellWidth: number, cellHeight: number, tileCols: number, tileRows: number): Tiler {
    const existing = this.tiler
    if (existing && existing.width === this.width && existing.height === this.height) return existing
    const tiler = new Tiler(this.width, this.height, cellWidth, cellHeight, tileCols, tileRows)
    this.tiler = tiler
    this.fullBuffer = Buffer.alloc(this.width * this.height * 4)
    this.tileHashes = new Float64Array(tiler.tiles.length)
    this.candidateRects = new Int32Array(tiler.tiles.length * 4)
    this.candidateHashes = new Float64Array(tiler.tiles.length)
    this.placedTiles.clear()
    this.needsFullFrame = true
    return tiler
  }

  /** Forget everything we believe the terminal is showing for this surface. */
  reset(): void {
    this.needsFullFrame = true
    this.placedTiles.clear()
    this.tilesMayBePlaced = true
    this.pendingDamage = null
  }

  isLive(): boolean {
    const w = this.window
    return w !== null && !w.isDestroyed() && !w.webContents.isDestroyed()
  }
}
