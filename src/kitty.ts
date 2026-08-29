/**
 * Kitty graphics protocol transports.
 *
 * Two axes:
 *   full vs tile — send the whole frame, or only the tiles the dirty rect touched
 *   b64  vs shm  — inline zlib+base64 through the PTY, or a POSIX shared-memory object the
 *                  terminal maps directly (and unlinks afterwards)
 */

import { deflateSync } from 'node:zlib'

export type Transport = 'b64' | 'shm'
export type Strategy = 'full' | 'tile'

export interface Mode {
  strategy: Strategy
  transport: Transport
}

export const MODES: readonly Mode[] = [
  { strategy: 'full', transport: 'b64' },
  { strategy: 'full', transport: 'shm' },
  { strategy: 'tile', transport: 'b64' },
  { strategy: 'tile', transport: 'shm' },
]

export function modeName(m: Mode): string {
  return `${m.strategy}-${m.transport}`
}

const CHUNK = 4096
/** z-index: below text (so the stats line stays readable) but above the cell background. */
const Z = -1

/** Display an image already sitting in a shared-memory object. The terminal unlinks it after reading. */
export function placeShm(
  id: number,
  width: number,
  height: number,
  name: string,
  format: 24 | 32,
): string {
  const payload = Buffer.from(name, 'utf8').toString('base64')
  return `\x1b_Ga=T,t=s,f=${format},s=${width},v=${height},i=${id},z=${Z},q=2,C=1;${payload}\x1b\\`
}

/**
 * Pack RGBA down to RGB. The alpha channel is constant for an opaque page, so f=24 removes a
 * quarter of the bytes before compression — which matters only on the inline path, where bytes
 * cross the pty.
 */
function packRgb(rgba: Buffer, pixels: number): Buffer {
  const rgb = Buffer.allocUnsafe(pixels * 3)
  for (let i = 0, o = 0; i < pixels; i++) {
    const p = i * 4
    rgb[o++] = rgba[p] as number
    rgb[o++] = rgba[p + 1] as number
    rgb[o++] = rgba[p + 2] as number
  }
  return rgb
}

/** Transmit pixels inline as zlib + base64, chunked, and display them. */
export function placeInline(
  id: number,
  width: number,
  height: number,
  rgba: Buffer,
): { escapes: string; bytes: number } {
  const payload = deflateSync(packRgb(rgba, width * height), { level: 1 }).toString('base64')
  let escapes = ''
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK)
    const more = i + CHUNK < payload.length ? 1 : 0
    escapes +=
      i === 0
        ? `\x1b_Ga=T,f=24,o=z,s=${width},v=${height},i=${id},z=${Z},q=2,C=1,m=${more};${slice}\x1b\\`
        : `\x1b_Gm=${more};${slice}\x1b\\`
  }
  return { escapes, bytes: payload.length }
}

/** Free an image and all of its placements. */
export function deleteImage(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`
}

/**
 * DEC mode 2026 brackets a frame so the terminal presents all of its placements at once.
 * Without it a multi-tile frame can be shown half-updated, which reads as tearing.
 */
export const BEGIN_FRAME = '\x1b[?2026h'
export const END_FRAME = '\x1b[?2026l'

/** Move the cursor to a 0-based cell position. */
export function cursorTo(col: number, row: number): string {
  return `\x1b[${row + 1};${col + 1}H`
}
