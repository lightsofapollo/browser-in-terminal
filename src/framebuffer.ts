/**
 * BGRA -> RGBA conversion and tile-based damage tracking.
 *
 * Electron hands us a full-frame BGRA bitmap plus a dirty rect. The kitty protocol wants RGBA,
 * and re-uploading the whole frame is the thing we are trying to avoid, so we slice the frame
 * into a grid of cell-aligned tiles and only convert + transmit the tiles the dirty rect touches.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Tile {
  index: number
  /** device pixels */
  x: number
  y: number
  width: number
  height: number
  /** cell position, for cursor placement */
  col: number
  row: number
  buffer: Buffer
}

/**
 * Convert a rectangle of a BGRA source into a tightly packed RGBA destination.
 * Little-endian: a BGRA byte order buffer read as uint32 is 0xAARRGGBB; RGBA byte order
 * wants 0xAABBGGRR, so red and blue swap and green/alpha stay put.
 */
export function convertRect(
  src: Buffer,
  srcWidth: number,
  rect: Rect,
  dst: Uint8Array,
): void {
  const s32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >>> 2)
  const d32 = new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >>> 2)
  let d = 0
  for (let y = 0; y < rect.height; y++) {
    let s = (rect.y + y) * srcWidth + rect.x
    const end = s + rect.width
    for (; s < end; s++, d++) {
      const v = s32[s] as number
      d32[d] = (v & 0xff00ff00) | ((v & 0x00ff0000) >>> 16) | ((v & 0x000000ff) << 16)
    }
  }
}

export class Tiler {
  readonly tiles: Tile[] = []
  readonly cols: number
  readonly rows: number

  /**
   * Tiles are laid out in CELL space using the terminal's own cell size.
   *
   * A kitty placement is positioned at a cell, so a tile's pixels must begin exactly where that
   * cell begins. Two ways to get this wrong, both of which put tiles beside the pixels they were
   * cut from and leave strips of stale content between them:
   *
   *   1. sizing a tile as `round(cellWidth * tileCols)` pixels, which drifts off the grid whenever
   *      a cell is not a whole number of pixels;
   *   2. deriving the cell size as `windowPixels / columns`, which is not the terminal's cell size
   *      — terminals use an integer cell and leave the remainder as padding.
   *
   * So the caller passes the cell size the terminal reported (CSI 16 t) and tile bounds are exact
   * integer multiples of it.
   */
  constructor(
    readonly width: number,
    readonly height: number,
    readonly cellWidth: number,
    readonly cellHeight: number,
    /** tile size in cells */
    tileCols = 10,
    tileRows = 5,
  ) {
    const cw = Math.max(1, Math.round(cellWidth))
    const ch = Math.max(1, Math.round(cellHeight))
    const tileW = Math.max(1, Math.round(tileCols)) * cw
    const tileH = Math.max(1, Math.round(tileRows)) * ch
    this.cols = Math.ceil(width / tileW)
    this.rows = Math.ceil(height / tileH)

    let index = 0
    for (let ty = 0; ty < this.rows; ty++) {
      const y = ty * tileH
      const h = Math.min(tileH, height - y)
      for (let tx = 0; tx < this.cols; tx++) {
        const x = tx * tileW
        const w = Math.min(tileW, width - x)
        if (w <= 0 || h <= 0) continue
        this.tiles.push({
          index,
          x,
          y,
          width: w,
          height: h,
          // exact, because x and y are whole multiples of the cell size
          col: x / cw,
          row: y / ch,
          buffer: Buffer.alloc(w * h * 4),
        })
        index++
      }
    }
  }

  /** Tiles whose area intersects the given rect. */
  intersecting(rect: Rect): Tile[] {
    const out: Tile[] = []
    const right = rect.x + rect.width
    const bottom = rect.y + rect.height
    for (const t of this.tiles) {
      if (t.x < right && t.x + t.width > rect.x && t.y < bottom && t.y + t.height > rect.y) {
        out.push(t)
      }
    }
    return out
  }
}
