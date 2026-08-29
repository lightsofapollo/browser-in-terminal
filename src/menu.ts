/** The in-page context menu: markup, styles, and the script that drives it. */

export interface MenuItem {
  action: string
  label: string
  enabled: boolean
}

/** Choose items the way a browser would, from what was actually clicked. */
export function itemsFor(params: {
  isEditable: boolean
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }
  selectionText: string
  linkURL: string
}): MenuItem[] {
  const flags = params.editFlags
  const items: MenuItem[] = []
  if (params.linkURL) {
    items.push({ action: 'copyLink', label: 'Copy Link', enabled: true })
  }
  if (params.isEditable) {
    items.push({ action: 'undo', label: 'Undo', enabled: true })
    items.push({ action: 'redo', label: 'Redo', enabled: true })
    items.push({ action: 'separator', label: '', enabled: false })
    items.push({ action: 'cut', label: 'Cut', enabled: flags.canCut })
  }
  items.push({ action: 'copy', label: 'Copy', enabled: flags.canCopy || Boolean(params.selectionText) })
  if (params.isEditable) {
    items.push({ action: 'paste', label: 'Paste', enabled: flags.canPaste })
  }
  items.push({ action: 'selectAll', label: 'Select All', enabled: flags.canSelectAll })
  items.push({ action: 'separator', label: '', enabled: false })
  items.push({ action: 'reload', label: 'Reload', enabled: true })
  return items
}

/**
 * Script injected to draw the menu. It lives in a closed shadow root so the page's own styles
 * cannot reach it and it cannot disturb the page's layout.
 */
export function showMenuScript(x: number, y: number, items: MenuItem[]): string {
  return `(() => {
  const HOST_ID = '__term_menu_host'
  document.getElementById(HOST_ID)?.remove()
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647'
  const root = host.attachShadow({ mode: 'closed' })
  const items = ${JSON.stringify(items)}
  const style = document.createElement('style')
  style.textContent = \`
    .scrim { position: fixed; inset: 0; }
    .menu {
      position: fixed; min-width: 190px; padding: 5px;
      background: #23262e; border: 1px solid #363b47; border-radius: 9px;
      box-shadow: 0 12px 34px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4);
      font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #e6e9f0;
      user-select: none;
    }
    .item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; border-radius: 6px; cursor: default; white-space: nowrap;
    }
    .item:hover:not(.disabled) { background: #6f8cff; color: #0d1017; }
    .item.disabled { color: #666c7a; }
    .sep { height: 1px; margin: 5px 8px; background: #363b47; }
  \`
  const scrim = document.createElement('div')
  scrim.className = 'scrim'
  const menu = document.createElement('div')
  menu.className = 'menu'
  for (const item of items) {
    if (item.action === 'separator') {
      const sep = document.createElement('div'); sep.className = 'sep'; menu.append(sep); continue
    }
    const el = document.createElement('div')
    el.className = 'item' + (item.enabled ? '' : ' disabled')
    el.textContent = item.label
    if (item.enabled) {
      el.addEventListener('mousedown', event => {
        event.preventDefault(); event.stopPropagation()
        host.remove()
        window.__term?.menuAction(item.action)
      })
    }
    menu.append(el)
  }
  scrim.addEventListener('mousedown', () => host.remove())
  window.addEventListener('keydown', function onKey(event) {
    if (event.key === 'Escape') { host.remove(); window.removeEventListener('keydown', onKey) }
  })
  root.append(style, scrim, menu)
  document.documentElement.append(host)
  // Keep the menu on screen: flip it when it would run past an edge.
  const rect = menu.getBoundingClientRect()
  const left = ${x} + rect.width > innerWidth ? Math.max(0, ${x} - rect.width) : ${x}
  const top = ${y} + rect.height > innerHeight ? Math.max(0, ${y} - rect.height) : ${y}
  menu.style.left = left + 'px'
  menu.style.top = top + 'px'
})()`
}

export function hideMenuScript(): string {
  return `document.getElementById('__term_menu_host')?.remove()`
}
