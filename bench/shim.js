/**
 * Integration check for the in-page shims that replace native widgets.
 *
 * Native <select> popups and native context menus are OS-level surfaces that offscreen rendering
 * never hands us, so both are redrawn inside the page. These assertions run against a real
 * Chromium so the interception path is exercised, not just the script text.
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { SELECT_SHIM, showMenuScript, itemsFor } = require(join(__dirname, '..', 'build', 'lib.cjs'))

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : '  — ' + detail}`)
  if (!ok) failures.push(name)
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 600, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true } })
  const paints = []
  win.webContents.on('paint', (_e, rect) => paints.push(rect))
  await win.loadFile(join(__dirname, '..', 'demo', 'index.html'))
  await win.webContents.executeJavaScript(`window.__show('form')`)
  await win.webContents.executeJavaScript(SELECT_SHIM)

  const select = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('select')
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const opened = !!document.getElementById('__term_select_host')
    let changed = 0
    el.addEventListener('change', () => changed++)
    el.selectedIndex = 2
    el.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('__term_select_host')?.remove()
    const closed = !document.getElementById('__term_select_host')
    return { opened, closed, changed, options: el.options.length }
  })()`)
  check('select mousedown opens an in-page dropdown', select.opened)
  check('the dropdown can be dismissed', select.closed)
  check('choosing an option fires change', select.changed === 1, `fired ${select.changed}`)

  const idempotent = await win.webContents.executeJavaScript(`(() => {
    const before = window.__termSelectShim
    return { before }
  })()`)
  check('the shim marks itself so it is injected once', idempotent.before === true)

  // An offscreen view is not focused by default, and Chromium only blinks a caret in a focused
  // view — so text fields appeared to have no cursor even though typing worked.
  const unfocused = await win.webContents.executeJavaScript('document.hasFocus()')
  win.focusOnWebView()
  await new Promise(resolve => setTimeout(resolve, 200))
  const focused = await win.webContents.executeJavaScript('document.hasFocus()')
  check('focusOnWebView focuses the view without showing a window', !unfocused && focused,
        `before=${unfocused} after=${focused}`)

  await win.webContents.executeJavaScript(`document.getElementById('name').focus()`)
  paints.length = 0
  await new Promise(resolve => setTimeout(resolve, 3500))
  const caretPaints = paints.filter(r => r.width <= 8 && r.height >= 10)
  check('a focused text field blinks a caret', caretPaints.length >= 2,
        `${caretPaints.length} narrow repaints in 3.5s of ${paints.length} total`)

  const items = itemsFor({
    isEditable: true,
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
    selectionText: '',
    linkURL: '',
  })
  const menu = await win.webContents.executeJavaScript(`(() => {
    ${showMenuScript(40, 40, items)}
    const host = document.getElementById('__term_menu_host')
    const present = !!host
    host?.remove()
    return { present }
  })()`)
  check('context menu renders into the page', menu.present)

  console.log(failures.length ? `\nFAILED: ${failures.join(', ')}` : '\nall shim checks passed')
  app.exit(failures.length ? 1 : 0)
})
