import { ipcRenderer } from 'electron'

import {
  SYSTEM_CHANNELS,
  type LogEvent,
  type SystemApi
} from '../../shared/ipc'

export const systemBridge: SystemApi = {
  chooseOutputDirectory: () =>
    ipcRenderer.invoke(SYSTEM_CHANNELS.chooseOutputDirectory),
  revealInFolder: (target) =>
    ipcRenderer.invoke(SYSTEM_CHANNELS.revealInFolder, target),

  onLog: (listener: (event: LogEvent) => void) => {
    const handler = (_e: unknown, event: LogEvent): void => listener(event)
    ipcRenderer.on(SYSTEM_CHANNELS.logEvent, handler)
    return () => ipcRenderer.removeListener(SYSTEM_CHANNELS.logEvent, handler)
  },

  cancelWork: () => ipcRenderer.invoke(SYSTEM_CHANNELS.cancelWork),
  getAppInfo: () => ipcRenderer.invoke(SYSTEM_CHANNELS.getAppInfo)
}
