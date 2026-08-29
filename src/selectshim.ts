/**
 * In-page replacement for native <select> dropdowns.
 *
 * Chromium renders a select popup as a native widget in its own offscreen surface, which Electron
 * does not hand to us — so in a terminal the control highlights and nothing opens. This script
 * intercepts the interaction and draws an equivalent listbox in the page, where it composites
 * through the normal pipeline like any other pixels.
 *
 * Injected into every page that loads, so an app needs no changes to be usable in a terminal.
 */
export const SELECT_SHIM = `(() => {
  if (window.__termSelectShim) return
  window.__termSelectShim = true
  const HOST_ID = '__term_select_host'

  const close = () => document.getElementById(HOST_ID)?.remove()

  function open(select) {
    close()
    const host = document.createElement('div')
    host.id = HOST_ID
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646'
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = \`
      .scrim { position: fixed; inset: 0; }
      .list {
        position: fixed; max-height: 320px; overflow-y: auto; padding: 5px;
        background: #23262e; border: 1px solid #363b47; border-radius: 9px;
        box-shadow: 0 12px 34px rgba(0,0,0,.55);
        font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #e6e9f0;
        user-select: none;
      }
      .opt { padding: 7px 10px; border-radius: 6px; cursor: default; white-space: nowrap; }
      .opt[aria-selected="true"] { background: #2f3542; }
      .opt.active { background: #6f8cff; color: #0d1017; }
      .opt.disabled { color: #666c7a; }
    \`
    const scrim = document.createElement('div')
    scrim.className = 'scrim'
    const list = document.createElement('div')
    list.className = 'list'
    list.setAttribute('role', 'listbox')

    const options = Array.from(select.options)
    let active = select.selectedIndex < 0 ? 0 : select.selectedIndex

    const commit = index => {
      const option = options[index]
      if (!option || option.disabled) return
      close()
      if (select.selectedIndex !== index) {
        select.selectedIndex = index
        select.dispatchEvent(new Event('input', { bubbles: true }))
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      select.focus()
    }

    const render = () => {
      for (let i = 0; i < list.children.length; i++) {
        list.children[i].classList.toggle('active', i === active)
      }
    }

    options.forEach((option, index) => {
      const el = document.createElement('div')
      el.className = 'opt' + (option.disabled ? ' disabled' : '')
      el.setAttribute('role', 'option')
      el.setAttribute('aria-selected', String(index === select.selectedIndex))
      el.textContent = option.label || option.text
      el.addEventListener('mousemove', () => { active = index; render() })
      el.addEventListener('mousedown', event => { event.preventDefault(); commit(index) })
      list.append(el)
    })

    const onKey = event => {
      if (event.key === 'Escape') { close(); window.removeEventListener('keydown', onKey, true) }
      else if (event.key === 'ArrowDown') { active = Math.min(options.length - 1, active + 1); render() }
      else if (event.key === 'ArrowUp') { active = Math.max(0, active - 1); render() }
      else if (event.key === 'Enter' || event.key === ' ') { commit(active) }
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    scrim.addEventListener('mousedown', close)
    root.append(style, scrim, list)
    document.documentElement.append(host)

    // Sit under the control, flipping up when there is no room below.
    const box = select.getBoundingClientRect()
    list.style.minWidth = box.width + 'px'
    const size = list.getBoundingClientRect()
    const below = innerHeight - box.bottom
    list.style.left = Math.min(box.left, Math.max(0, innerWidth - size.width)) + 'px'
    list.style.top = (below >= size.height || below >= box.top
      ? box.bottom + 2
      : Math.max(0, box.top - size.height - 2)) + 'px'
    render()
  }

  const intercept = event => {
    const select = event.target instanceof Element ? event.target.closest('select') : null
    if (!select || select.disabled || select.multiple || select.size > 1) return
    event.preventDefault()
    event.stopPropagation()
    open(select)
  }

  document.addEventListener('mousedown', intercept, true)
  document.addEventListener('keydown', event => {
    const select = document.activeElement
    if (select && select.tagName === 'SELECT' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      open(select)
    }
  }, true)
})()`
