/** Raw-mode terminal I/O: geometry query, alt screen, mouse/keyboard protocol setup, HUD text. */

import { appendFileSync, openSync } from 'node:fs'
import { ReadStream } from 'node:tty'

export interface Capabilities {
  /** the terminal answered the kitty graphics query */
  kittyGraphics: boolean
  /**
   * the terminal could actually read a shared-memory object we created. False over SSH, where the
   * terminal is on another machine and our shm object does not exist for it, and anywhere else the
   * transport is unavailable. Without this check the shm path fails silently and draws nothing.
   */
  sharedMemory: boolean
  /** the terminal answered at all (DA1), i.e. the probe completed rather than timing out */
  responded: boolean
  /** raw DA1 response, useful when diagnosing an unsupported terminal */
  da1: string
}

export interface Geometry {
  /** window size in device pixels, from CSI 14 t */
  pxWidth: number
  pxHeight: number
  /** grid size in cells, from CSI 18 t */
  cols: number
  rows: number
  cellWidth: number
  cellHeight: number
  /** true when the terminal answered CSI 16 t rather than us dividing */
  cellSizeReported: boolean
}

const ENABLE =
  '\x1b[?1049h' + // alt screen
  '\x1b[?25l' + // hide cursor
  '\x1b[?1003h' + // report all mouse motion
  '\x1b[?1006h' + // SGR mouse encoding
  '\x1b[?1016h' + // SGR-pixels: report in pixels, not cells
  '\x1b[?7l' + // no autowrap: a status line as wide as the screen must not scroll the view
  '\x1b[?1004h' + // focus in/out reporting, so we can idle when nobody is looking
  '\x1b[?2004h' + // bracketed paste
  '\x1b[>27u' // kitty keyboard: disambiguate + event types + all keys as escapes + text

const DISABLE =
  '\x1b_Ga=d,d=A,q=2\x1b\\' + // delete every image we placed
  '\x1b[<u' +
  '\x1b[?7h' +
  '\x1b[?2004l\x1b[?1004l' +
  '\x1b[?1016l\x1b[?1006l\x1b[?1003l' +
  '\x1b[?25h' +
  '\x1b[?1049l'

export class Terminal {
  private enabled = false
  private input: NodeJS.ReadStream
  private consumer: ((chunk: Buffer) => void) | null = null
  /** How many times the input stream died and had to be reopened. */
  recoveries = 0
  /** How many times the terminal was found out of raw mode and put back. */
  rawRestores = 0

  constructor(
    input: NodeJS.ReadStream,
    private readonly output: NodeJS.WriteStream,
  ) {
    this.input = input
  }

  /**
   * Take ownership of terminal input. A tty read can fail with EIO, and Node's response is to
   * destroy the stream — after which no 'data' event ever fires again, so input dies permanently
   * while everything else keeps running. Reopen /dev/tty and carry on instead.
   */
  attach(consumer: (chunk: Buffer) => void): void {
    this.consumer = consumer
    this.bindInput()
  }

  private bindInput(): void {
    const stream = this.input
    if (this.consumer) stream.on('data', this.consumer)
    stream.on('error', (err: Error) => this.recoverInput(err))
    stream.on('close', () => this.recoverInput(new Error('input stream closed')))
  }

  /**
   * Re-establish terminal input after a read error.
   *
   * The previous version destroyed the old stream first and then opened /dev/tty. When that open
   * fails — ENXIO does happen — the process is left with no input stream AND a terminal knocked
   * out of raw mode, so the tty echoes our own mouse and key escapes as text while the app sits
   * frozen. Never give up the working stream until a replacement is proven, and always force raw
   * mode back on whatever we end up with.
   */
  private recoverInput(err: Error): void {
    if (!this.enabled) return
    this.recoveries++
    appendFileSync('/tmp/et-error.log', `${new Date().toISOString()} input recovery: ${err.message}\n`)

    const previous = this.input
    try {
      previous.removeAllListeners()
    } catch {
      /* nothing to detach */
    }

    const candidates: (() => NodeJS.ReadStream)[] = [
      () => new ReadStream(openSync('/dev/tty', 'r')) as unknown as NodeJS.ReadStream,
      // fd 0 is still the terminal even when /dev/tty cannot be opened
      () => new ReadStream(0) as unknown as NodeJS.ReadStream,
    ]
    for (const make of candidates) {
      try {
        const fresh = make()
        fresh.setRawMode(true)
        fresh.resume()
        this.input = fresh
        this.bindInput()
        this.reassertModes()
        if (previous !== fresh) {
          try {
            previous.destroy()
          } catch {
            /* the old stream is already gone */
          }
        }
        return
      } catch (reopenErr) {
        appendFileSync('/tmp/et-error.log', `  reopen failed: ${String(reopenErr)}\n`)
      }
    }

    // Nothing could be opened: keep the stream we had rather than ending up with none.
    try {
      previous.setRawMode(true)
      previous.resume()
      this.input = previous
      this.bindInput()
      this.reassertModes()
      appendFileSync('/tmp/et-error.log', '  kept the existing stream\n')
    } catch (keepErr) {
      appendFileSync('/tmp/et-error.log', `  could not keep the stream: ${String(keepErr)}\n`)
    }
  }

  /**
   * Raw mode is what stops the terminal echoing the mouse and key escapes we asked it to send.
   * If anything knocks us out of it the screen fills with garbage and input stops arriving, so
   * check periodically rather than assuming it stuck.
   */
  ensureRawMode(isReallyRaw?: () => boolean): boolean {
    if (!this.enabled) return true
    // Never trust stream.isRaw: it is Node's own cached flag, set when WE last called setRawMode,
    // so it cannot see the mode being changed from anywhere else.
    let raw: boolean
    try {
      raw = isReallyRaw ? isReallyRaw() : this.input.isRaw === true
    } catch {
      raw = true
    }
    if (process.env['ET_DEBUG_RAW']) {
      appendFileSync('/tmp/et-error.log', `${new Date().toISOString()} rawcheck native=${raw} nodeIsRaw=${this.input.isRaw}\n`)
    }
    if (raw) return true
    try {
      // libuv short-circuits uv_tty_set_mode when its cached mode already matches, so asking for
      // raw again does nothing at all when Node believes we are already raw. Toggle through
      // cooked to force the attributes to be applied.
      if (this.input.isRaw) this.input.setRawMode(false)
      this.input.setRawMode(true)
      this.input.resume()
      this.rawRestores++
      appendFileSync('/tmp/et-error.log', `${new Date().toISOString()} raw mode restored\n`)
      this.reassertModes()
    } catch {
      /* nothing further we can do here */
    }
    return false
  }

  isTty(): boolean {
    return Boolean(this.input.isTTY && this.output.isTTY)
  }

  enable(): void {
    if (this.enabled) return
    this.input.setRawMode(true)
    this.input.resume()
    this.output.write(ENABLE)
    this.enabled = true
  }

  disable(): void {
    if (!this.enabled) return
    this.output.write(DISABLE)
    try {
      this.input.setRawMode(false)
    } catch {
      /* the stream may already be torn down */
    }
    this.enabled = false
  }

  /**
   * Re-send the mouse and keyboard mode sequences. These are idempotent, and re-asserting them
   * is the cure for the case where something else on the tty resets them: SGR-pixels mode
   * silently reverting to cell coordinates makes every click land in the wrong place, which
   * looks exactly like "input stopped working".
   */
  reassertModes(): void {
    if (!this.enabled) return
    this.output.write('\x1b[?1003h\x1b[?1006h\x1b[?1016h\x1b[?1004h\x1b[?2004h\x1b[>27u')
  }

  write(data: string | Uint8Array): void {
    this.output.write(data)
  }

  /**
   * One round trip that asks for geometry AND kitty graphics support, terminated by a DA1 request.
   *
   * DA1 is the sentinel: every terminal answers it, so a terminal that ignores the graphics query
   * still completes the probe instead of making us wait out a timeout. Without it a plain xterm
   * would stall for a second and then be handed a screen full of escape garbage.
   */
  async probe(
    timeoutMs = 2000,
    shmProbeName?: string,
  ): Promise<{ geometry: Geometry; capabilities: Capabilities }> {
    return await new Promise((resolve, reject) => {
      let buf = ''
      const finish = (
        err: Error | null,
        value?: { geometry: Geometry; capabilities: Capabilities },
      ): void => {
        clearTimeout(timer)
        this.input.off('data', onData)
        if (err) reject(err)
        else if (value) resolve(value)
      }
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('latin1')
        const da1 = /\x1b\[\?([0-9;]*)c/.exec(buf)
        if (!da1) return // wait for the sentinel before deciding anything

        const px = /\x1b\[4;(\d+);(\d+)t/.exec(buf)
        const cells = /\x1b\[8;(\d+);(\d+)t/.exec(buf)
        const cellPx = /\x1b\[6;(\d+);(\d+)t/.exec(buf)
        const graphicsOk = /\x1b_Gi=31[;,][^\x1b]*OK/.test(buf)
        const shmOk = /\x1b_Gi=32[;,][^\x1b]*OK/.test(buf)

        if (!px || !cells) {
          finish(new Error('terminal did not report pixel geometry (CSI 14 t / CSI 18 t)'))
          return
        }
        const pxHeight = Number(px[1])
        const pxWidth = Number(px[2])
        const rows = Number(cells[1])
        const cols = Number(cells[2])
        if (!pxWidth || !pxHeight || !rows || !cols) {
          finish(new Error('terminal reported zero geometry'))
          return
        }
        // Prefer the reported cell size; fall back to the quotient only if the terminal is silent.
        const cellHeight = cellPx ? Number(cellPx[1]) : pxHeight / rows
        const cellWidth = cellPx ? Number(cellPx[2]) : pxWidth / cols
        finish(null, {
          geometry: {
            pxWidth,
            pxHeight,
            cols,
            rows,
            cellWidth: cellWidth > 0 ? cellWidth : pxWidth / cols,
            cellHeight: cellHeight > 0 ? cellHeight : pxHeight / rows,
            cellSizeReported: Boolean(cellPx),
          },
          capabilities: {
            kittyGraphics: graphicsOk,
            sharedMemory: shmOk,
            responded: true,
            da1: da1[1] ?? '',
          },
        })
      }
      const timer = setTimeout(() => {
        finish(new Error('terminal did not answer the capability probe (needs kitty or ghostty)'))
      }, timeoutMs)
      this.input.on('data', onData)
      // 1x1 RGB image, query only (a=q): supporting terminals reply OK and draw nothing.
      // CSI 16 t is the authoritative cell size in pixels. Dividing window pixels by columns is
      // NOT the same number: terminals use an integer cell and leave padding, so the quotient
      // drifts and every tile placement lands a little further from its pixels.
      // a=q validates without drawing. The second query hands the terminal a real shared-memory
      // object: if it cannot open it — over SSH it cannot — we must not use that transport.
      const shmQuery =
        shmProbeName === undefined
          ? ''
          : `\x1b_Gi=32,s=1,v=1,a=q,t=s,f=24;${Buffer.from(shmProbeName, 'utf8').toString('base64')}\x1b\\`
      this.output.write(
        '\x1b[14t\x1b[18t\x1b[16t' +
          '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\' +
          shmQuery +
          '\x1b[c',
      )
    })
  }

  /**
   * Draw a single line of plain text at a 1-based row, clearing the rest of the line.
   * The text is truncated to the grid width: a line that reaches the last column of the last row
   * scrolls the whole view up by one, which would drag the placed images with it.
   */
  hud(row: number, text: string, cols: number): void {
    const clipped = text.length > cols - 1 ? text.slice(0, cols - 1) : text
    this.output.write(`\x1b[${row};1H\x1b[2K\x1b[38;5;245m${clipped}\x1b[0m`)
  }
}
