/**
 * Git-backed collaboration.
 *
 * The one entry point for everything multiplayer. Consumers depend on
 * `CollaborationProvider`, not on `GitCollaborationProvider`, so a future
 * real-time transport is a new implementation rather than a rewrite.
 */

export {
  buildAgentBrief,
  summarizeBrief,
  type AgentBriefOptions
} from './agent-context'
export {
  claimSession,
  markSessionOffline,
  pendingInstructions,
  runTaskAgent,
  type RunTaskAgentOptions,
  type RunTaskAgentResult
} from './agent-session'
export { runCommand, type CommandResult } from './run-command'
export {
  assessIntegration,
  mergeTaskBranch,
  runValidation,
  type IntegrationAssessment,
  type IntegrationInput,
  type MergeResult
} from './integration'
export {
  detectConflicts,
  diffPublicSurface,
  externalDependentsOf,
  formatConflictReport,
  type ChangeSetSummary,
  type SymbolChange
} from './conflicts'
export {
  buildScope,
  checkScope,
  describeScopeCheck,
  isSharedConfigPath,
  ownerOf,
  pathInScope,
  type ScopeCheck,
  type ScopeViolation
} from './scope'
export {
  branchForTask,
  commitTaskWork,
  discardTaskWorkspace,
  listTaskWorkspaces,
  prepareTaskWorkspace,
  taskChangedPaths,
  type TaskWorkspace
} from './tasks'
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
