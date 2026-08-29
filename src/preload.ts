/**
 * Preload bridge for the in-page context menu.
 *
 * A native Electron menu is an OS window: in offscreen rendering it would open on the desktop
 * rather than in the terminal, where nobody would see it. So the menu is drawn in the page and
 * only the chosen action crosses back to the main process.
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('__term', {
  menuAction: (action: string): void => {
    ipcRenderer.send('term:menu-action', action)
  },
})
