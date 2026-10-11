/**
 * The preload bridge.
 *
 * The renderer has no Node integration. This script runs in an isolated
 * context and exposes exactly one object — `window.cartograph`, typed as
 * `CartographApi` — so the surface the UI can reach is a closed, reviewable
 * list rather than "whatever the renderer can import".
 *
 * Menu commands arrive here too, and are re-published as DOM events so the
 * React app can listen for them without touching Electron.
 */

import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type CartographApi, type LogEvent } from '../shared/types/ipc'

const MENU_CHANNELS = [
  'menu:open-project',
  'menu:save-graph',
  'menu:analyze',
  'menu:add-module',
  'menu:relayout',
  'menu:generate',
  'menu:settings'
] as const

const api: CartographApi = {
  openProject: () => ipcRenderer.invoke(IPC.openProject),
  openProjectAt: (root) => ipcRenderer.invoke(IPC.openProjectAt, root),
  analyze: (root, options) => ipcRenderer.invoke(IPC.analyze, root, options),

  loadDocument: (root) => ipcRenderer.invoke(IPC.loadDocument, root),
  saveDocument: (req) => ipcRenderer.invoke(IPC.saveDocument, req),

  readProjectFile: (root, relPath) =>
    ipcRenderer.invoke(IPC.readProjectFile, root, relPath),

  planChanges: (root, req) => ipcRenderer.invoke(IPC.planChanges, root, req),
  previewDiff: (changeSet) => ipcRenderer.invoke(IPC.previewDiff, changeSet),
  applyChanges: (root, req) => ipcRenderer.invoke(IPC.applyChanges, root, req),
  validateProject: (root) => ipcRenderer.invoke(IPC.validateProject, root),

  chooseOutputDirectory: () => ipcRenderer.invoke(IPC.chooseOutputDirectory),
  revealInFolder: (target) => ipcRenderer.invoke(IPC.revealInFolder, target),

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  testApiKey: () => ipcRenderer.invoke(IPC.testApiKey),

  onLog: (listener: (event: LogEvent) => void) => {
    const handler = (_e: unknown, event: LogEvent): void => listener(event)
    ipcRenderer.on(IPC.logEvent, handler)
    return () => ipcRenderer.removeListener(IPC.logEvent, handler)
  },

  cancelWork: () => ipcRenderer.invoke(IPC.cancelWork),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo)
}

contextBridge.exposeInMainWorld('cartograph', api)

for (const channel of MENU_CHANNELS) {
  ipcRenderer.on(channel, () => {
    window.dispatchEvent(new CustomEvent(channel))
  })
}
