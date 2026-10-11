/**
 * Git-backed collaboration.
 *
 * The one entry point for everything multiplayer. Consumers depend on
 * `CollaborationProvider`, not on `GitCollaborationProvider`, so a future
 * real-time transport is a new implementation rather than a rewrite.
 */

export { COLLAB_BRANCH, COLLAB_FILES, deserializeState, serializeState } from './layout'
export { GitCollaborationProvider, type GitProviderOptions } from './git-provider'
export type {
  CollaborationOperation,
  CollaborationProvider,
  Freshness,
  IntegrationPatch,
  NewTask,
  SessionPatch,
  SyncReport
} from './provider'
export {
  cloneForCollaboration,
  initializeCollaboration,
  inspectWorkspace,
  integrationScratchDir,
  joinCollaboration,
  loadOrCreateIdentity,
  worktreeRootFor,
  type InitializeOptions,
  type WorkspaceInfo
} from './workspace'
