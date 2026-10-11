/**
 * The preload bridge.
 *
 * The renderer has no Node integration. This script runs in an isolated
 * context and exposes exactly one object — `window.cartograph`, typed as
 * `CartographApi` — so the surface the UI can reach is a closed, reviewable
 * list rather than "whatever the renderer can import". The methods themselves
 * live in `./bridges`, one file per domain.
 *
 * Application commands arrive here too, and are re-published as DOM events so
 * the React app can listen for them without touching Electron. Every command
 * in `COMMAND_CHANNELS` is forwarded, so adding one does not mean editing this
 * file.
 */

import { contextBridge, ipcRenderer } from 'electron'

import { COMMAND_CHANNELS } from '../shared/ipc'
import { api } from './bridges'

contextBridge.exposeInMainWorld('cartograph', api)

for (const channel of COMMAND_CHANNELS) {
  ipcRenderer.on(channel, () => {
    window.dispatchEvent(new CustomEvent(channel))
  })
}
