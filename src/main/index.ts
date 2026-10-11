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
import { applyProfile, windowTitle } from './profile'
import { SettingsStore } from './services/settings-store'
import { createWindow } from './window'

const distDir = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// Before anything else, and before the single-instance lock: the lock is
// scoped to `userData`, so a profile has to be in place or a second instance
// would still quit. See ./profile.ts.
const profile = applyProfile()

let mainWindow: BrowserWindow | null = null
let disposeHandlers: (() => void) | null = null

function send(command: CommandName): void {
  mainWindow?.webContents.send(command)
}

function newWindow(): BrowserWindow {
  return createWindow({ distDir, isDev, title: windowTitle(profile) })
}

// One window is the whole application *per profile*; a second instance of the
// same profile should focus the first rather than starting a rival.
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
      getWindow: () => mainWindow,
      userDataDir: app.getPath('userData')
    })
    if (profile.name) {
      // Said out loud: a profiled instance has its own settings and its own
      // collaboration identity, and a user needs to know which one they are
      // looking at before they wonder why their API key is missing.
      console.log(
        `Cartograph profile "${profile.name}" — separate settings and collaboration identity in ${profile.userDataDir}`
      )
    }

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
