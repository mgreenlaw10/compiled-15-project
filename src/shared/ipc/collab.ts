/**
 * Collaboration over IPC.
 *
 * Served by `src/main/ipc/modules/collab.ts`. The renderer never touches Git:
 * it submits collaboration operations and reads the model back, exactly as it
 * would against a real-time server.
 */

import type { ModuleId } from '../types/architecture'
import type {
  AgentSession,
  ModuleReservation,
  ProjectState,
  Task
} from '../collab'

export interface WorkspaceStatus {
  root: string
  isGitRepository: boolean
  remoteUrl: string | null
  currentBranch: string | null
  headCommit: string | null
  collaborationInitialized: boolean
  /** `true` once this instance has attached to the project. */
  connected: boolean
  dirtyFileCount: number
  identity: { name: string; email: string }
  /** This install's developer id, as recorded on operations. */
  developerId: string | null
}

/** What one synchronization pass achieved. Never optimistic. */
export interface SyncStatus {
  online: boolean
  lastSyncAt: string | null
  /** `true` when the cached view is too old to present as current. */
  stale: boolean
  /** Local changes not yet on the remote. */
  queued: number
  stateCommit: string | null
  retries: number
  contested: { kind: string; id: string }[]
  expiredReservations: ModuleId[]
  error: string | null
}

export interface CollabSnapshot {
  state: ProjectState
  sync: SyncStatus
  workspace: WorkspaceStatus
  /** Task worktrees on this machine. Local paths, never shared. */
  worktrees: { taskId: string; path: string; branch: string | null; head: string }[]
}

export interface CreateTaskRequest {
  title: string
  description: string
  moduleIds: ModuleId[]
  assignedAgent?: string | null
  graphVersion: number
  /** Reserve the modules at the same time. */
  claimModules?: boolean
}

export interface StartAgentRequest {
  taskId: string
}

export interface StartAgentResult {
  sessionId: string
  started: boolean
  message: string
}

export interface SubmitIntegrationRequest {
  taskId: string
}

export interface IntegrationReport {
  requestId: string
  status: string
  conflicts: import('../collab').IntegrationConflict[]
  validations: import('../collab').ValidationOutcome[]
  changedPaths: string[]
  outOfScopePaths: string[]
  scopeSummary: string
  mergesCleanly: boolean
  note: string | null
}

export interface CollabApi {
  /** What we can tell about a directory, without configuring anything. */
  inspectWorkspace(root: string): Promise<WorkspaceStatus>
  /** Create the coordination branch for a repository. */
  initializeCollaboration(req: {
    root: string
    projectName: string
    remoteUrl?: string
  }): Promise<WorkspaceStatus>
  /** Attach to a project someone else initialized. */
  joinCollaboration(root: string): Promise<WorkspaceStatus>
  /** Clone a remote so a second developer can join it. */
  cloneProject(req: { url: string; destination: string }): Promise<{ root: string }>
  /** Start serving collaboration state for an open project. */
  connect(root: string): Promise<CollabSnapshot>
  disconnect(): Promise<void>

  /** Local cached read. No network. */
  getSnapshot(): Promise<CollabSnapshot | null>
  /** Fetch, merge, publish, retry. The only networked call. */
  synchronize(): Promise<CollabSnapshot>

  createTask(req: CreateTaskRequest): Promise<Task>
  updateTask(req: { taskId: string; changes: Partial<Task> }): Promise<void>
  claimModule(req: { moduleId: ModuleId; taskId: string }): Promise<void>
  releaseModule(moduleId: ModuleId): Promise<void>

  startAgent(req: StartAgentRequest): Promise<StartAgentResult>
  sendInstruction(req: { sessionId: string; text: string }): Promise<void>
  cancelAgent(taskId: string): Promise<void>

  /** Assess without changing anything. */
  assessIntegration(req: SubmitIntegrationRequest): Promise<IntegrationReport>
  submitIntegration(req: SubmitIntegrationRequest): Promise<IntegrationReport>
  /** Merge an assessed task into the integrated branch. */
  integrateTask(req: SubmitIntegrationRequest): Promise<IntegrationReport>

  /** The diff a task's branch would contribute. */
  taskDiff(taskId: string): Promise<{ patch: string; changedPaths: string[] }>

  /**
   * Subscribe to shared-state changes. The backend polls Git; this pushes the
   * result, so the renderer needs no timer of its own. Returns an unsubscribe.
   */
  onCollabChanged(listener: (snapshot: CollabSnapshot) => void): () => void

  getTasks(): Promise<Task[]>
  getSessions(): Promise<AgentSession[]>
  getReservations(): Promise<ModuleReservation[]>
}
