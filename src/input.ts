/**
 * Terminal input -> structured events.
 *
 * Mouse: SGR (CSI ?1006h) with pixel coordinates (CSI ?1016h), including extended buttons and
 * horizontal wheel tilt. Keyboard: the kitty keyboard protocol at flags 1|2|8|16, which reports
 * every key as an escape code with an event type and the associated text — so real key press,
 * repeat and release are all available, not just synthesized presses.
 */

export interface MouseEvent {
  kind: 'mouse'
  action: 'move' | 'down' | 'up' | 'wheel'
  /** device pixels, relative to the terminal window */
  x: number
  y: number
  button: 'left' | 'middle' | 'right' | 'back' | 'forward'
  wheelX: number
  wheelY: number
  shift: boolean
  alt: boolean
  ctrl: boolean
}

export interface KeyEvent {
  kind: 'key'
  /** unicode codepoint for printable keys, 0 when only `named` applies */
  code: number
  /** an Electron Accelerator key name for non-printable keys */
  named: string | null
  text: string | null
  action: 'press' | 'repeat' | 'release'
  shift: boolean
  alt: boolean
  ctrl: boolean
  meta: boolean
}

export interface PasteEvent {
  kind: 'paste'
  text: string
}

export interface FocusEvent {
  kind: 'focus'
  focused: boolean
}

export type TermEvent = MouseEvent | KeyEvent | PasteEvent | FocusEvent

/**
 * Kitty reports functional keys in the Unicode Private Use Area. Any code in this range that we
 * have no name for (modifier keys report themselves here at flags >= 8) must produce NO text:
 * synthesising String.fromCodePoint(57441) types a PUA glyph into whatever has focus.
 */
const FUNCTIONAL_MIN = 57344
const FUNCTIONAL_MAX = 57534

/**
 * kitty functional key codes -> Electron Accelerator names.
 * Note these are Accelerator names ("Up"), not DOM names ("ArrowUp"): sendInputEvent rejects the latter.
 */
const FUNCTIONAL: ReadonlyMap<number, string> = new Map([
  [27, 'Escape'],
  [13, 'Return'],
  [9, 'Tab'],
  [127, 'Backspace'],
  [57358, 'Capslock'],
  [57359, 'Scrolllock'],
  [57360, 'Numlock'],
  [57361, 'PrintScreen'],
  [57362, 'Pause'],
  // keypad
  [57399, 'num0'], [57400, 'num1'], [57401, 'num2'], [57402, 'num3'], [57403, 'num4'],
  [57404, 'num5'], [57405, 'num6'], [57406, 'num7'], [57407, 'num8'], [57408, 'num9'],
  [57409, 'numdec'], [57410, 'numdiv'], [57411, 'nummult'], [57412, 'numsub'], [57413, 'numadd'],
  [57414, 'Return'],
  // modifier keys report themselves at flags >= 8; Electron has no standalone keyCode for them,
  // and their state already rides on every other event, so they map to null and are dropped.
])

for (let i = 0; i < 23; i++) FUNCTIONAL_F(i) // F13..F35 = 57376..57398
function FUNCTIONAL_F(i: number): void {
  ;(FUNCTIONAL as Map<number, string>).set(57376 + i, `F${13 + i}`)
}

/** CSI final byte -> Accelerator name (keys that keep their legacy encoding). */
const CSI_LEGACY: Readonly<Record<string, string>> = {
  A: 'Up',
  B: 'Down',
  C: 'Right',
  D: 'Left',
  H: 'Home',
  F: 'End',
  P: 'F1',
  Q: 'F2',
  S: 'F4',
}

/** CSI <n> ~ -> Accelerator name. */
const CSI_TILDE: Readonly<Record<number, string>> = {
  2: 'Insert', 3: 'Delete', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End',
  11: 'F1', 12: 'F2', 13: 'F3', 14: 'F4', 15: 'F5', 17: 'F6', 18: 'F7',
  19: 'F8', 20: 'F9', 21: 'F10', 23: 'F11', 24: 'F12',
}

function mods(bits: number): { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean } {
  const m = Math.max(0, bits - 1)
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0, meta: (m & 8) !== 0 }
}

export class InputParser {
  private buf = ''
  private pasting = false
  private pasteBuf = ''

  push(chunk: Buffer): TermEvent[] {
    this.buf += chunk.toString('latin1')
    const events: TermEvent[] = []
    let i = 0

    while (i < this.buf.length) {
      const ch = this.buf[i]
      if (ch === undefined) break

      if (ch !== '\x1b') {
        if (this.pasting) {
          this.pasteBuf += ch
          i += 1
          continue
        }
        const consumed = this.parseLiteral(this.buf, i, events)
        if (consumed === 0) break
        i += consumed
        continue
      }

      if (i + 1 >= this.buf.length) break
      const next = this.buf[i + 1]

      // OSC / DCS / APC / PM / SOS are terminal replies, not input. Skip to the string terminator.
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        const end = this.findStringTerminator(this.buf, i + 2)
        if (end < 0) break
        i = end
        continue
      }

      if (next !== '[') {
        const c = this.buf[i + 1]
        if (c === undefined) break
        if (this.pasting) {
          this.pasteBuf += ch + c
        } else {
          events.push(this.makeKey(c.codePointAt(0) ?? 0, c, 2))
        }
        i += 2
        continue
      }

      const end = this.findFinal(this.buf, i + 2)
      if (end < 0) break
      this.parseCsi(this.buf.slice(i, end + 1), events)
      i = end + 1
    }

    this.buf = this.buf.slice(i)
    return events
  }

  private findStringTerminator(s: string, from: number): number {
    for (let i = from; i < s.length; i++) {
      if (s[i] === '\x07') return i + 1
      if (s[i] === '\x1b' && s[i + 1] === '\\') return i + 2
      if (s[i] === '\x1b' && i + 1 >= s.length) return -1
    }
    return -1
  }

  private findFinal(s: string, from: number): number {
    for (let i = from; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 0x40 && c <= 0x7e) return i
    }
    return -1
  }

  private parseLiteral(s: string, i: number, out: TermEvent[]): number {
    const cp = s.codePointAt(i)
    if (cp === undefined) return 0
    const char = String.fromCodePoint(cp)
    const size = char.length
    if (cp === 13 || cp === 9 || cp === 127) {
      out.push(this.makeKey(cp, null, 1))
      return size
    }
    if (cp < 32) {
      const letter = String.fromCharCode(cp + 96)
      out.push(this.makeKey(letter.codePointAt(0) ?? 0, null, 5))
      return size
    }
    out.push(this.makeKey(cp, char, 1))
    return size
  }

  private parseCsi(seq: string, out: TermEvent[]): void {
    const final = seq[seq.length - 1]
    const body = seq.slice(2, seq.length - 1)

    // --- bracketed paste ---
    if (final === '~' && body === '200') {
      this.pasting = true
      this.pasteBuf = ''
      return
    }
    if (final === '~' && body === '201') {
      this.pasting = false
      if (this.pasteBuf) out.push({ kind: 'paste', text: this.pasteBuf })
      this.pasteBuf = ''
      return
    }
    if (this.pasting) {
      this.pasteBuf += seq
      return
    }

    // --- focus in / out (CSI ?1004h) ---
    if (final === 'I') {
      out.push({ kind: 'focus', focused: true })
      return
    }
    if (final === 'O') {
      out.push({ kind: 'focus', focused: false })
      return
    }

    // --- mouse: CSI < b ; x ; y M|m ---
    if (body.startsWith('<') && (final === 'M' || final === 'm')) {
      const nums = body.slice(1).split(';').map(Number)
      const [code, x, y] = nums
      if (code === undefined || x === undefined || y === undefined) return
      if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) return

      const isWheel = (code & 64) !== 0
      const isExtended = (code & 128) !== 0
      const isMotion = (code & 32) !== 0
      const low = code & 3
      const release = final === 'm'

      let button: MouseEvent['button'] = 'left'
      let wheelX = 0
      let wheelY = 0
      let action: MouseEvent['action']

      if (isWheel) {
        action = 'wheel'
        // 64 up, 65 down, 66 tilt left, 67 tilt right
        if (low === 0) wheelY = 1
        else if (low === 1) wheelY = -1
        else if (low === 2) wheelX = 1
        else wheelX = -1
      } else if (isExtended) {
        // buttons 8..11: back, forward, and two more nobody maps
        button = low === 0 ? 'back' : low === 1 ? 'forward' : 'left'
        action = isMotion ? 'move' : release ? 'up' : 'down'
      } else {
        button = low === 0 ? 'left' : low === 1 ? 'middle' : 'right'
        action = isMotion ? 'move' : release ? 'up' : 'down'
      }

      out.push({
        kind: 'mouse',
        action,
        x,
        y,
        button,
        wheelX,
        wheelY,
        shift: (code & 4) !== 0,
        alt: (code & 8) !== 0,
        ctrl: (code & 16) !== 0,
      })
      return
    }

    // --- kitty keyboard: CSI code[:shifted:base];mods[:event][;text] u ---
    if (final === 'u') {
      const fields = body.split(';')
      const code = Number((fields[0] ?? '0').split(':')[0] ?? 0)
      const modParts = (fields[1] ?? '1').split(':')
      const modBits = Number(modParts[0] ?? 1)
      const eventType = Number(modParts[1] ?? 1)
      const action: KeyEvent['action'] =
        eventType === 3 ? 'release' : eventType === 2 ? 'repeat' : 'press'
      let text: string | null = null
      const textField = fields[2]
      if (textField) {
        text = textField.split(':').map(n => String.fromCodePoint(Number(n))).join('')
      } else if (code >= 32 && code !== 127 && code < FUNCTIONAL_MIN) {
        text = String.fromCodePoint(code)
      }
      out.push(this.makeKey(code, text, modBits, action))
      return
    }

    // --- legacy arrows / home / end / F-keys, optionally with modifiers ---
    if (final && CSI_LEGACY[final]) {
      const parts = body.split(';')
      const modParts = (parts[1] ?? '1').split(':')
      const eventType = Number(modParts[1] ?? 1)
      out.push({
        kind: 'key',
        code: 0,
        named: CSI_LEGACY[final] ?? null,
        text: null,
        action: eventType === 3 ? 'release' : eventType === 2 ? 'repeat' : 'press',
        ...mods(Number(modParts[0] ?? 1)),
      })
      return
    }

    if (final === '~') {
      const parts = body.split(';')
      const named = CSI_TILDE[Number(parts[0] ?? 0)]
      if (!named) return
      const modParts = (parts[1] ?? '1').split(':')
      const eventType = Number(modParts[1] ?? 1)
      out.push({
        kind: 'key',
        code: 0,
        named,
        text: null,
        action: eventType === 3 ? 'release' : eventType === 2 ? 'repeat' : 'press',
        ...mods(Number(modParts[0] ?? 1)),
      })
    }
  }

  private makeKey(
    code: number,
    text: string | null,
    modBits: number,
    action: KeyEvent['action'] = 'press',
  ): KeyEvent {
    const named = FUNCTIONAL.get(code) ?? null
    // An unnamed key in the functional range (shift, control, super, unmapped media keys) has no
    // Electron keyCode and no text. Zero the code so it resolves to nothing and is dropped.
    const unmappedFunctional = named === null && code >= FUNCTIONAL_MIN && code <= FUNCTIONAL_MAX
    return {
      kind: 'key',
      code: unmappedFunctional ? 0 : code,
      named,
      text: named !== null || unmappedFunctional ? null : text,
      action,
      ...mods(modBits),
    }
  }
}
