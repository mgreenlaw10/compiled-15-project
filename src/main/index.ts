/**
 * Electron main process: application lifecycle.
 *
 * Deliberately small. Window creation and the security posture live in
 * `./window.ts`, the menu in `./menu.ts`, and every backend capability in
 * `./ipc/modules/`. All real work happens in `src/core`, reached through the
 * IPC layer; this file contains no analysis or filesystem logic.
 */

import { BrowserWindow, app } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { IPC, type CommandName } from '../shared/ipc'
import { registerHandlers } from './ipc'
import { installMenu } from './menu'
import { SettingsStore } from './services/settings-store'
import { createWindow } from './window'

const distDir = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let disposeHandlers: (() => void) | null = null

function send(command: CommandName): void {
  mainWindow?.webContents.send(command)
}

function newWindow(): BrowserWindow {
  return createWindow({ distDir, isDev })
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

    installMenu({ send, getWindow: () => mainWindow })
    mainWindow = newWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = newWindow()
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
