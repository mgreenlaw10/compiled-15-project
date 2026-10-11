/**
 * The slice manifest.
 *
 * Re-exported here so `store.ts` stays a composition root and nothing else.
 */

export { createDocumentSlice } from './document'
export { createGenerationSlice } from './generation'
export { createGraphSlice, describeOperation } from './graph'
export { createLayoutSlice } from './layout'
export { createLogSlice, uiLog, MAX_LOGS } from './logs'
export { createProjectSlice } from './project'
export { createSelectionSlice } from './selection'
export { createSessionSlice } from './session'
export { createSettingsSlice } from './settings'
export { createUiSlice } from './ui'
