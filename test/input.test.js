const test = require('node:test')
const assert = require('node:assert')
const { InputParser } = require('../build/lib.cjs')

const parse = (...chunks) => {
  const p = new InputParser()
  const out = []
  for (const c of chunks) out.push(...p.push(Buffer.from(c, 'latin1')))
  return out
}

test('mouse buttons map to left/middle/right', () => {
  assert.equal(parse('\x1b[<0;10;10M')[0].button, 'left')
  assert.equal(parse('\x1b[<1;10;10M')[0].button, 'middle')
  assert.equal(parse('\x1b[<2;10;10M')[0].button, 'right')
})

test('press and release are distinguished by the final byte', () => {
  assert.equal(parse('\x1b[<2;10;10M')[0].action, 'down')
  assert.equal(parse('\x1b[<2;10;10m')[0].action, 'up')
})

test('coordinates are carried through unscaled', () => {
  const e = parse('\x1b[<0;812;430M')[0]
  assert.equal(e.x, 812)
  assert.equal(e.y, 430)
})

test('extended buttons are back/forward, not a left click', () => {
  // Regression: bit 128 used to fall through to (code & 3) and register as a left click.
  assert.equal(parse('\x1b[<128;5;5M')[0].button, 'back')
  assert.equal(parse('\x1b[<129;5;5M')[0].button, 'forward')
})

test('wheel reports vertical and horizontal separately', () => {
  assert.deepEqual(pick(parse('\x1b[<64;1;1M')[0]), { wheelX: 0, wheelY: 1 })
  assert.deepEqual(pick(parse('\x1b[<65;1;1M')[0]), { wheelX: 0, wheelY: -1 })
  assert.deepEqual(pick(parse('\x1b[<66;1;1M')[0]), { wheelX: 1, wheelY: 0 })
  assert.deepEqual(pick(parse('\x1b[<67;1;1M')[0]), { wheelX: -1, wheelY: 0 })
})
const pick = e => ({ wheelX: e.wheelX, wheelY: e.wheelY })

test('modifier bits decode', () => {
  const e = parse('\x1b[<20;1;1M')[0] // 16 ctrl + 4 shift
  assert.equal(e.ctrl, true)
  assert.equal(e.shift, true)
  assert.equal(e.alt, false)
})

test('kitty keys report press, repeat and release', () => {
  assert.equal(parse('\x1b[97;1;97u')[0].action, 'press')
  assert.equal(parse('\x1b[97;1:2;97u')[0].action, 'repeat')
  assert.equal(parse('\x1b[97;1:3u')[0].action, 'release')
})

test('arrows use Accelerator names, not DOM names', () => {
  // Regression: 'ArrowUp' is rejected by sendInputEvent, so arrows silently did nothing.
  assert.equal(parse('\x1b[A')[0].named, 'Up')
  assert.equal(parse('\x1b[1;5C')[0].named, 'Right')
  assert.equal(parse('\x1b[1;5C')[0].ctrl, true)
})

test('function and keypad keys resolve', () => {
  assert.equal(parse('\x1b[15~')[0].named, 'F5')
  assert.equal(parse('\x1b[24~')[0].named, 'F12')
  assert.equal(parse('\x1b[57399;1u')[0].named, 'num0')
})

test('terminal replies never become keystrokes', () => {
  // Regression: an OSC colour reply used to arrive as ~24 synthetic key events.
  assert.deepEqual(parse('\x1b]11;rgb:1616/1818/1d1d\x1b\\'), [])
  assert.deepEqual(parse('\x1bP>|ghostty 1.3.1\x1b\\'), [])
  assert.deepEqual(parse('\x1b[?62;22c'), [])
  assert.deepEqual(parse('\x1b[4;900;1600t\x1b[8;45;160t'), [])
})

test('bracketed paste arrives as one event, escapes intact', () => {
  const e = parse('\x1b[200~hello world\x1b[201~')
  assert.equal(e.length, 1)
  assert.equal(e[0].kind, 'paste')
  assert.equal(e[0].text, 'hello world')
  assert.equal(parse('\x1b[200~a\x1b[Bb\x1b[201~')[0].text, 'a\x1b[Bb')
})

test('focus in/out are reported, not typed', () => {
  assert.deepEqual(parse('\x1b[O').map(e => e.focused), [false])
  assert.deepEqual(parse('\x1b[I').map(e => e.focused), [true])
})

test('sequences split across chunks still parse once', () => {
  assert.equal(parse('\x1b[<0;10', '0;90M').length, 1)
})

test('a partial sequence never deadlocks the parser', () => {
  const p = new InputParser()
  assert.deepEqual(p.push(Buffer.from('\x1b')), [])
  assert.equal(p.push(Buffer.from('[<0;1;1M')).length, 1)
})

test('an event flood is not dropped', () => {
  const flood = Array(500).fill('\x1b[<35;10;10M').join('')
  assert.equal(parse(flood).length, 500)
})

test('space produces text, not a named key with no character', () => {
  // Regression: mapping 32 to the named key "Space" suppressed the char event, so typing a
  // space did nothing at all.
  const e = parse('\x1b[32;1;32u')[0]
  assert.equal(e.named, null)
  assert.equal(e.text, ' ')
})

test('modifier keys type nothing', () => {
  // Regression: kitty reports shift as key 57441 (Private Use Area). Falling back to
  // String.fromCodePoint(57441) typed a PUA glyph into the focused field.
  for (const code of [57441, 57442, 57443, 57444, 57447, 57448]) {
    const e = parse(`\x1b[${code};1u`)[0]
    assert.equal(e.text, null, `code ${code} must not produce text`)
    assert.equal(e.named, null, `code ${code} has no Electron keyCode`)
    assert.equal(e.code, 0, `code ${code} must resolve to nothing`)
  }
})

test('named functional keys still resolve and type nothing', () => {
  const e = parse('\x1b[57359;1u')[0] // scroll lock
  assert.equal(e.named, 'Scrolllock')
  assert.equal(e.text, null)
})
