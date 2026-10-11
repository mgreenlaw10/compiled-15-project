/**
 * Electron main process.
 *
 * Window lifecycle, the application menu, and the security posture. All real
 * work happens in `src/core`, reached through the IPC handlers; this file
 * deliberately contains no analysis or filesystem logic.
 */

import { BrowserWindow, Menu, app, dialog, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { IPC } from '../shared/types/ipc'
import { registerHandlers } from './ipc/handlers'
import { SettingsStore } from './services/settings-store'

const here = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let disposeHandlers: (() => void) | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Cartograph',
    backgroundColor: '#14161a',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(here, '../preload/index.mjs'),
      // The renderer gets no Node access at all; everything goes through the
      // preload bridge, which exposes only the methods in `CartographApi`.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.once('ready-to-show', () => window.show())

  // Links to the outside world open in the user's browser, never in-app.
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

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(here, '../renderer/index.html'))
  }

  return window
}

function send(channel: string): void {
  mainWindow?.webContents.send(channel)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('menu:open-project')
        },
        {
          label: 'Save Architecture',
          accelerator: 'CmdOrCtrl+S',
          click: () => send('menu:save-graph')
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => send('menu:settings')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Architecture',
      submenu: [
        {
          label: 'Re-analyze Project',
          accelerator: 'CmdOrCtrl+R',
          click: () => send('menu:analyze')
        },
        {
          label: 'Add Module',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => send('menu:add-module')
        },
        {
          label: 'Auto Layout',
          accelerator: 'CmdOrCtrl+L',
          click: () => send('menu:relayout')
        },
        { type: 'separator' },
        {
          label: 'Generate Project…',
          accelerator: 'CmdOrCtrl+G',
          click: () => send('menu:generate')
        }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'About Cartograph',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'Cartograph',
              message: 'Cartograph',
              detail: [
                'An AI-powered visual codebase editor.',
                '',
                'Import a codebase, see its architecture as an editable module',
                'graph, change the graph, and regenerate the source to match.',
                '',
                `Electron ${process.versions.electron} · Node ${process.versions.node}`
              ].join('\n')
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// One window is the whole application; a second instance should focus it.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    const settings = SettingsStore.create()
    disposeHandlers = registerHandlers({
      settings,
      getWindow: () => mainWindow
    })

    buildMenu()
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    disposeHandlers?.()
    disposeHandlers = null
  })
}

// Keep the IPC channel list honest: a typo here would be a silent dead button.
export const CHANNELS = IPC
