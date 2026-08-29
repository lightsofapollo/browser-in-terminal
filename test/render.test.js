const test = require('node:test')
const assert = require('node:assert')
const { Tiler, convertRect, Histogram, Metrics, placeShm, placeInline, deleteImage, cursorTo } = require('../build/lib.cjs')

test('tiles start on cell boundaries and cover the viewport', () => {
  const t = new Tiler(1600, 900, 10, 20, 10, 5)
  assert.equal(t.tiles.length, t.cols * t.rows)
  for (const tile of t.tiles) {
    assert.equal(tile.x, tile.col * 10)
    assert.equal(tile.y, tile.row * 20)
    assert.ok(tile.x + tile.width <= 1600)
    assert.ok(tile.y + tile.height <= 900)
  }
  const area = t.tiles.reduce((n, x) => n + x.width * x.height, 0)
  assert.equal(area, 1600 * 900) // exact cover, no gaps and no overlap
})

test('a tile is drawn exactly where its pixels came from, with fractional cells', () => {
  // Regression: tiles used to be sized round(cellWidth * tileCols) pixels, which drifts away from
  // the cell grid whenever a cell is not a whole number of pixels. The placement then lands beside
  // the pixels it was cut from, leaving strips of stale content on screen.
  // window pixels that are NOT a whole multiple of the cell size — the real case, where a
  // terminal keeps the remainder as padding
  for (const [w, h, cw, ch] of [[3400, 1900, 11, 27], [1601, 901, 10, 21], [2559, 1439, 9, 19]]) {
    const t = new Tiler(w, h, cw, ch, 10, 5)
    for (const tile of t.tiles) {
      assert.equal(tile.x, tile.col * cw, `tile ${tile.index} x vs its cell in ${w}x${h}`)
      assert.equal(tile.y, tile.row * ch, `tile ${tile.index} y vs its cell in ${w}x${h}`)
      assert.ok(Number.isInteger(tile.col) && Number.isInteger(tile.row), 'cell coords are integers')
    }
    const area = t.tiles.reduce((n, x) => n + x.width * x.height, 0)
    assert.equal(area, w * h, `exact cover in ${w}x${h}: no gaps, no overlap`)
    // neighbours must abut exactly
    for (let i = 0; i < t.tiles.length; i++) {
      const tile = t.tiles[i]
      const right = t.tiles[i + 1]
      if (right && right.y === tile.y) assert.equal(tile.x + tile.width, right.x, 'horizontal seam')
    }
  }
})

test('intersecting returns only tiles the rect touches', () => {
  const t = new Tiler(1000, 500, 10, 10, 10, 5)
  const hit = t.intersecting({ x: 0, y: 0, width: 1, height: 1 })
  assert.equal(hit.length, 1)
  assert.equal(t.intersecting({ x: 0, y: 0, width: 1000, height: 500 }).length, t.tiles.length)
})

test('convertRect turns BGRA into RGBA', () => {
  const src = Buffer.from([0x11, 0x22, 0x33, 0xff]) // B,G,R,A
  const dst = Buffer.alloc(4)
  convertRect(src, 1, { x: 0, y: 0, width: 1, height: 1 }, dst)
  assert.deepEqual([...dst], [0x33, 0x22, 0x11, 0xff]) // R,G,B,A
})

test('convertRect copies a sub-rect from a wider source', () => {
  const src = Buffer.alloc(4 * 4 * 2) // 4px wide, 2 rows
  src[4 * 4 + 4] = 0xaa // row 1, px 1, blue channel
  const dst = Buffer.alloc(4)
  convertRect(src, 4, { x: 1, y: 1, width: 1, height: 1 }, dst)
  assert.equal(dst[2], 0xaa) // blue lands in the third byte
})

test('escapes carry the protocol flags that matter', () => {
  const shm = placeShm(7, 100, 50, '/et-1', 24)
  assert.match(shm, /a=T/)
  assert.match(shm, /f=24/)
  assert.match(shm, /t=s/)
  assert.match(shm, /i=7/)
  assert.match(shm, /C=1/) // must not move the cursor
  assert.match(shm, /q=2/) // must not generate replies into our input stream
  assert.match(shm, /z=-1/) // below text, above background
  assert.match(deleteImage(7), /a=d,d=I,i=7/)
  assert.equal(cursorTo(0, 0), '\x1b[1;1H')
})

test('the inline path packs to f=24 and chunks', () => {
  const out = placeInline(1, 64, 64, Buffer.alloc(64 * 64 * 4, 0x40))
  assert.match(out.escapes, /f=24/)
  assert.ok(out.bytes > 0)
  for (const chunk of out.escapes.split('\x1b_G').slice(1)) {
    assert.ok(chunk.length <= 4200, 'chunks stay within the protocol limit')
  }
})

test('histogram percentiles are nearest-rank', () => {
  const h = new Histogram(1000)
  for (let i = 1; i <= 100; i++) h.record(i)
  assert.equal(h.count, 100)
  assert.equal(h.percentile(50), 50)
  assert.equal(h.percentile(95), 95)
  assert.equal(h.percentile(100), 100)
  assert.equal(h.max, 100)
  assert.equal(h.min, 1)
})

test('histogram retains only its window', () => {
  const h = new Histogram(8)
  for (let i = 0; i < 100; i++) h.record(i)
  assert.equal(h.count, 8)
})

test('metrics rates measure from the warmup baseline', () => {
  const m = new Metrics()
  for (let i = 0; i < 10; i++) m.recordFrame(1, 0.5, 0.3, 0.2, 1000, 2)
  m.resetTimings()
  const snap = m.snapshot(0, 0)
  assert.equal(snap.bytes.totalMiB, 0, 'bytes before the baseline are excluded')
  assert.equal(snap.timings.frame.count, 0, 'warmup samples are discarded')
  assert.equal(snap.counters.frames, 10, 'cumulative counters survive')
})

const { itemsFor, showMenuScript } = require('../build/lib.cjs')

test('context menu items follow what was clicked', () => {
  const plain = itemsFor({
    isEditable: false,
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
    selectionText: '',
    linkURL: '',
  }).map(i => i.action)
  assert.ok(!plain.includes('paste'), 'no paste outside an editable field')
  assert.ok(plain.includes('selectAll'))

  const editable = itemsFor({
    isEditable: true,
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
    selectionText: 'hi',
    linkURL: '',
  }).map(i => i.action)
  assert.ok(['undo', 'redo', 'cut', 'copy', 'paste'].every(a => editable.includes(a)))

  const link = itemsFor({
    isEditable: false,
    editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
    selectionText: '',
    linkURL: 'https://example.com',
  })
  assert.equal(link[0].action, 'copyLink')
})

test('the menu is drawn in the page, not as a native window', () => {
  const script = showMenuScript(10, 20, [{ action: 'copy', label: 'Copy', enabled: true }])
  assert.match(script, /attachShadow/, 'isolated from the page styles')
  assert.match(script, /position:fixed/)
  assert.match(script, /__term\?\.menuAction/, 'actions cross back over the preload bridge')
  assert.match(script, /innerWidth/, 'flips at the screen edge')
})

const { SELECT_SHIM } = require('../build/lib.cjs')

test('the select shim replaces the native dropdown in-page', () => {
  assert.match(SELECT_SHIM, /attachShadow/, 'isolated from page styles')
  assert.match(SELECT_SHIM, /mousedown', intercept, true/, 'capture phase, before the page sees it')
  assert.match(SELECT_SHIM, /preventDefault/, 'suppresses the native popup')
  assert.match(SELECT_SHIM, /new Event\('change'/, 'fires change so the page reacts')
  assert.match(SELECT_SHIM, /select\.multiple/, 'leaves multi-selects alone')
  assert.match(SELECT_SHIM, /ArrowDown/, 'keyboard navigable')
})

const { Surface } = require('../build/lib.cjs')

test('a surface owns a distinct kitty image id range', () => {
  // At equal z the higher image id composites on top, so two surfaces sharing ids draw over
  // each other. Ranges must not overlap.
  const page = new Surface(0, null)
  const devtools = new Surface(1, null)
  assert.equal(page.fullFrameId, 1)
  assert.ok(devtools.fullFrameId > page.tileId(2000), 'devtools ids sit above any page tile')
  assert.ok(devtools.tileId(0) > devtools.fullFrameId, 'tiles composite above their full frame')
})

test('a surface hit-tests its own rectangle', () => {
  const s = new Surface(1, null)
  s.place(800, 0, 800, 900, 80, 0)
  assert.equal(s.contains(900, 100), true)
  assert.equal(s.contains(700, 100), false, 'a point left of the split belongs to the page')
  assert.equal(s.contains(1600, 100), false, 'the right edge is exclusive')
})

test('replacing a surface rectangle invalidates its tiler', () => {
  const s = new Surface(0, null)
  s.place(0, 0, 100, 100, 0, 0)
  s.ensureTiler(10, 10, 2, 2)
  assert.ok(s.tiler)
  s.place(0, 0, 200, 100, 0, 0)
  assert.equal(s.tiler, null, 'a resized surface must rebuild its tiles')
  assert.equal(s.needsFullFrame, true)
})
