import { ipcRenderer } from 'electron'

import {
  COLLAB_CHANNELS,
  type CollabApi,
  type CollabSnapshot
} from '../../shared/ipc'

export const collabBridge: CollabApi = {
  inspectWorkspace: (root) =>
    ipcRenderer.invoke(COLLAB_CHANNELS.inspectWorkspace, root),
  initializeCollaboration: (req) =>
    ipcRenderer.invoke(COLLAB_CHANNELS.initializeCollaboration, req),
  joinCollaboration: (root) =>
    ipcRenderer.invoke(COLLAB_CHANNELS.joinCollaboration, root),
  cloneProject: (req) => ipcRenderer.invoke(COLLAB_CHANNELS.cloneProject, req),

  connect: (root) => ipcRenderer.invoke(COLLAB_CHANNELS.collabConnect, root),
  disconnect: () => ipcRenderer.invoke(COLLAB_CHANNELS.collabDisconnect),

  getSnapshot: () => ipcRenderer.invoke(COLLAB_CHANNELS.getSnapshot),
  synchronize: () => ipcRenderer.invoke(COLLAB_CHANNELS.synchronize),

  createTask: (req) => ipcRenderer.invoke(COLLAB_CHANNELS.createTask, req),
  updateTask: (req) => ipcRenderer.invoke(COLLAB_CHANNELS.updateTask, req),
  claimModule: (req) => ipcRenderer.invoke(COLLAB_CHANNELS.claimModule, req),
  releaseModule: (moduleId) =>
    ipcRenderer.invoke(COLLAB_CHANNELS.releaseModule, moduleId),

  startAgent: (req) => ipcRenderer.invoke(COLLAB_CHANNELS.startAgent, req),
  sendInstruction: (req) =>
    ipcRenderer.invoke(COLLAB_CHANNELS.sendInstruction, req),
  cancelAgent: (taskId) => ipcRenderer.invoke(COLLAB_CHANNELS.cancelAgent, taskId),

  assessIntegration: (req) =>
    ipcRenderer.invoke(COLLAB_CHANNELS.assessIntegration, req),
  submitIntegration: (req) =>
    ipcRenderer.invoke(COLLAB_CHANNELS.submitIntegration, req),
  integrateTask: (req) => ipcRenderer.invoke(COLLAB_CHANNELS.integrateTask, req),

  taskDiff: (taskId) => ipcRenderer.invoke(COLLAB_CHANNELS.taskDiff, taskId),

  onCollabChanged: (listener) => {
    const handler = (_e: unknown, snapshot: CollabSnapshot): void =>
      listener(snapshot)
    ipcRenderer.on(COLLAB_CHANNELS.collabChanged, handler)
    return () => ipcRenderer.removeListener(COLLAB_CHANNELS.collabChanged, handler)
  },

  getTasks: () => ipcRenderer.invoke(COLLAB_CHANNELS.getTasks),
  getSessions: () => ipcRenderer.invoke(COLLAB_CHANNELS.getSessions),
  getReservations: () => ipcRenderer.invoke(COLLAB_CHANNELS.getReservations)
}
