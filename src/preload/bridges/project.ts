import { ipcRenderer } from 'electron'

import { PROJECT_CHANNELS, type ProjectApi } from '../../shared/ipc'

export const projectBridge: ProjectApi = {
  openProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.openProject),
  openProjectAt: (root) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.openProjectAt, root),
  analyze: (root, options) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.analyze, root, options)
}
