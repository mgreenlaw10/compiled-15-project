import { ipcRenderer } from 'electron'

import { DOCUMENT_CHANNELS, type DocumentApi } from '../../shared/ipc'

export const documentBridge: DocumentApi = {
  loadDocument: (root) =>
    ipcRenderer.invoke(DOCUMENT_CHANNELS.loadDocument, root),
  saveDocument: (req) =>
    ipcRenderer.invoke(DOCUMENT_CHANNELS.saveDocument, req),
  readProjectFile: (root, relPath) =>
    ipcRenderer.invoke(DOCUMENT_CHANNELS.readProjectFile, root, relPath)
}
