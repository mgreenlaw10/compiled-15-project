/**
 * Collaboration UI.
 *
 * Everything multiplayer that the user sees. Reads the collaboration slice and
 * calls its actions; never touches Git, and never reaches for a Git concept the
 * backend has not already turned into part of the model.
 */

export { CollabSetupDialog } from './CollabSetupDialog'
export { CollaborationPanel } from './CollaborationPanel'
export { CreateTaskDialog } from './CreateTaskDialog'
export { IntegrationDialog } from './IntegrationDialog'
export { ModuleCollabBadge, type ModuleCollabBadgeProps } from './ModuleCollabBadge'
export { TeamSection } from './TeamSection'
export * from './use-collab'
