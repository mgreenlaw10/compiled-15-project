import { ipcRenderer } from 'electron'

import { GENERATION_CHANNELS, type GenerationApi } from '../../shared/ipc'

export const generationBridge: GenerationApi = {
  planChanges: (root, req) =>
    ipcRenderer.invoke(GENERATION_CHANNELS.planChanges, root, req),
  previewDiff: (changeSet) =>
    ipcRenderer.invoke(GENERATION_CHANNELS.previewDiff, changeSet),
  applyChanges: (root, req) =>
    ipcRenderer.invoke(GENERATION_CHANNELS.applyChanges, root, req),
  validateProject: (root) =>
    ipcRenderer.invoke(GENERATION_CHANNELS.validateProject, root)
}
