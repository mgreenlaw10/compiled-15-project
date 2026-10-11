/**
 * Shell-level operations: directory pickers, revealing files, cancelling work,
 * and app info.
 */

import { dialog, shell } from 'electron'

import { SYSTEM_CHANNELS, type AppInfo } from '../../../shared/ipc'
import { asString, type HandlerModule } from '../context'

export const systemHandlers: HandlerModule = (ctx) => ({
  [SYSTEM_CHANNELS.chooseOutputDirectory]: async () => {
    const win = ctx.getWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where to generate the project',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Generate here'
    }
    // Attached to the window when there is one so the dialog is modal.
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  },

  [SYSTEM_CHANNELS.revealInFolder]: async (_e: unknown, target: unknown) => {
    shell.showItemInFolder(asString(target, 'target'))
  },

  [SYSTEM_CHANNELS.cancelWork]: async () => {
    ctx.work.cancel()
    ctx.log.warn('Canceled the running task')
  },

  [SYSTEM_CHANNELS.getAppInfo]: async (): Promise<AppInfo> => ({
    version: process.env.npm_package_version ?? '0.1.0',
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node
  })
})
