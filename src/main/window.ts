/**
 * Window creation and the renderer's security posture.
 *
 * The renderer gets no Node access at all; everything goes through the preload
 * bridge, which exposes only the methods in `CartographApi`. Links to the
 * outside world open in the user's browser, never in-app.
 */

import { BrowserWindow, shell } from 'electron'
import path from 'node:path'

export interface WindowOptions {
  /** Directory of the built main process, used to locate preload and renderer. */
  distDir: string
  isDev: boolean
  /** Window title. Carries the profile name when one is set. */
  title?: string
}

export function createWindow(options: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: options.title ?? 'Cartograph',
    backgroundColor: '#14161a',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(options.distDir, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev && url.startsWith(dev)) return
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })

  if (options.isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(options.distDir, '../renderer/index.html'))
  }

  return window
}
