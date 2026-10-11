/**
 * IPC channel names, grouped by the handler module that serves them.
 *
 * Main and preload both read this map, so a typo cannot become a silently
 * dead button. Grouping matters for more than tidiness: each group is owned by
 * one handler module under `src/main/ipc/modules`, so adding a feature means
 * adding a group here and a module there rather than editing a shared file
 * everyone else is also editing.
 */

export const PROJECT_CHANNELS = {
  openProject: 'cartograph:open-project',
  openProjectAt: 'cartograph:open-project-at',
  analyze: 'cartograph:analyze'
} as const

export const DOCUMENT_CHANNELS = {
  loadDocument: 'cartograph:load-document',
  saveDocument: 'cartograph:save-document',
  readProjectFile: 'cartograph:read-project-file'
} as const

export const GENERATION_CHANNELS = {
  planChanges: 'cartograph:plan-changes',
  previewDiff: 'cartograph:preview-diff',
  applyChanges: 'cartograph:apply-changes',
  validateProject: 'cartograph:validate-project'
} as const

export const SETTINGS_CHANNELS = {
  getSettings: 'cartograph:get-settings',
  setSettings: 'cartograph:set-settings',
  testApiKey: 'cartograph:test-api-key'
} as const

export const COLLAB_CHANNELS = {
  inspectWorkspace: 'cartograph:collab-inspect-workspace',
  initializeCollaboration: 'cartograph:collab-initialize',
  joinCollaboration: 'cartograph:collab-join',
  cloneProject: 'cartograph:collab-clone',
  collabConnect: 'cartograph:collab-connect',
  collabDisconnect: 'cartograph:collab-disconnect',
  getSnapshot: 'cartograph:collab-get-snapshot',
  synchronize: 'cartograph:collab-synchronize',
  createTask: 'cartograph:collab-create-task',
  updateTask: 'cartograph:collab-update-task',
  claimModule: 'cartograph:collab-claim-module',
  releaseModule: 'cartograph:collab-release-module',
  startAgent: 'cartograph:collab-start-agent',
  sendInstruction: 'cartograph:collab-send-instruction',
  cancelAgent: 'cartograph:collab-cancel-agent',
  assessIntegration: 'cartograph:collab-assess-integration',
  submitIntegration: 'cartograph:collab-submit-integration',
  integrateTask: 'cartograph:collab-integrate-task',
  taskDiff: 'cartograph:collab-task-diff',
  getTasks: 'cartograph:collab-get-tasks',
  getSessions: 'cartograph:collab-get-sessions',
  getReservations: 'cartograph:collab-get-reservations',
  /** Pushed to the renderer when shared state changes. */
  collabChanged: 'cartograph:collab-changed'
} as const

export const SYSTEM_CHANNELS = {
  chooseOutputDirectory: 'cartograph:choose-output-directory',
  revealInFolder: 'cartograph:reveal-in-folder',
  cancelWork: 'cartograph:cancel-work',
  getAppInfo: 'cartograph:get-app-info',
  logEvent: 'cartograph:log-event'
} as const

/** Every channel, flattened. This is the map main and preload index by. */
export const IPC = {
  ...PROJECT_CHANNELS,
  ...DOCUMENT_CHANNELS,
  ...GENERATION_CHANNELS,
  ...SETTINGS_CHANNELS,
  ...COLLAB_CHANNELS,
  ...SYSTEM_CHANNELS
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
