/** Typed loader for the termbridge native addon (POSIX shm + IOSurface readback). */

import { createRequire } from 'node:module'

export interface ShmResult {
  bytes: number
}

export interface IOSurfaceShmResult extends ShmResult {
  surfaceWidth: number
  surfaceHeight: number
}

export interface TermBridge {
  /**
   * Convert a rect out of a CPU bitmap straight into a fresh POSIX shared-memory object.
   * Electron forbids external Buffers, so the mapping never reaches JavaScript.
   */
  shmFromBitmap(
    src: Buffer,
    srcStride: number,
    x: number,
    y: number,
    width: number,
    height: number,
    name: string,
    swapRB: boolean,
    /** pack to 3-byte RGB, dropping the constant alpha channel */
    packRgb?: boolean,
  ): ShmResult
  /** Same, reading from the IOSurface behind Electron's offscreen shared texture. */
  shmFromIOSurface(
    handle: Buffer,
    x: number,
    y: number,
    width: number,
    height: number,
    name: string,
    swapRB: boolean,
    packRgb?: boolean,
  ): IOSurfaceShmResult
  /**
   * Hash each candidate tile so we can tell which ones actually changed. Chromium reports one
   * union dirty rect, which over-reports badly when several small regions change; hashing recovers
   * the true damage. `tiles` is [x,y,w,h] repeated; `out` receives one 53-bit hash per tile.
   */
  hashTilesBitmap(src: Buffer, srcStride: number, tiles: Int32Array, out: Float64Array): void
  hashTilesIOSurface(handle: Buffer, tiles: Int32Array, out: Float64Array): void
  /** Read a rect out of the shared texture into an ordinary Buffer. */
  copyIOSurface(
    handle: Buffer,
    x: number,
    y: number,
    width: number,
    height: number,
    dst: Buffer,
    swapRB: boolean,
  ): void
  /**
   * Point file descriptor 2 at a file. Chromium logs from C++ directly to fd 2, so while we own
   * the screen those writes land inside our images; only dup2 can stop them.
   */
  redirectStderr(path: string): void
  /**
   * Whether the terminal is really in raw mode, read from its own attributes. Node caches this as
   * a flag on the stream, so it cannot notice the mode being changed from elsewhere.
   */
  terminalIsRaw(): boolean
  /** Remove a shared-memory object the terminal did not consume. */
  unlinkShm(name: string): void
  /** Convert/copy a rect out of a CPU bitmap into a normal Buffer. swapRB turns BGRA into RGBA. */
  convertRect(
    src: Buffer,
    srcStride: number,
    x: number,
    y: number,
    width: number,
    height: number,
    dst: Buffer,
    swapRB: boolean,
  ): void
  hasIOSurface: boolean
}

let cached: TermBridge | null = null
let loadError: string | null = null

export function loadNative(): TermBridge | null {
  if (cached) return cached
  if (loadError !== null) return null
  try {
    const require = createRequire(__filename)
    cached = require('../native/build/Release/termbridge.node') as TermBridge
    return cached
  } catch (err) {
    loadError = (err as Error).message
    return null
  }
}

export function nativeLoadError(): string | null {
  return loadError
}
