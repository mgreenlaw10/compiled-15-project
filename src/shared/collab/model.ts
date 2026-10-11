/**
 * The collaboration data model.
 *
 * Everything here is plain, serializable JSON, because it is stored as files on
 * a Git coordination branch and merged by value rather than by text. Three
 * properties matter and are relied on throughout:
 *
 *   - **Stable ids.** Entities are addressed by id, never by array position, so
 *     two clones that both append are merged by union rather than by diff.
 *   - **`revision` + `updatedAt`.** Every entity carries both, so a merge can
 *     pick a winner per entity instead of per file. Concurrent edits to
 *     *different* entities therefore both survive, which is the behaviour the
 *     acceptance criteria require.
 *   - **No secrets, no local paths.** This content is pushed to a shared
 *     remote. Worktree locations, API keys and tokens stay on the machine that
 *     owns them; see `ExecutionHost`.
 *
 * Git author identity is recorded for attribution only. It is not
 * authentication — actual repository access is the Git host's business.
 */

import type { ModuleId } from '../types/architecture'
import type { GraphOperation } from '../types/operations'

/** Bumped when the on-branch layout changes in a way readers must notice. */
export const COLLAB_SCHEMA_VERSION = 1

/** Fields every stored entity carries, so any of them can be merged by value. */
export interface Revisioned {
  /** Monotonic per entity. Incremented by whoever writes it. */
  revision: number
  /** ISO 8601. Tie-breaker when two clones reach the same revision. */
  updatedAt: string
  /** Developer id of the last writer, for attribution in the activity log. */
  updatedBy: string
}

// ---------------------------------------------------------------------------
// Project and people
// ---------------------------------------------------------------------------

export interface CollabProject extends Revisioned {
  id: string
  name: string
  /** Remote URL, for display and for recognising the same project. */
  repositoryUrl: string | null
  /** The canonical branch task work is integrated into. */
  integratedBranch: string
  /** Latest architecture graph version seen on the integrated branch. */
  architectureVersion: number
  settings: CollabSettings
}

export interface CollabSettings {
  /** How often to fetch the coordination branch, in seconds. */
  syncIntervalSeconds: number
  /** How long a module reservation survives without a heartbeat, in seconds. */
  reservationLeaseSeconds: number
  /**
   * Developer id permitted to publish to the integrated branch. `null` means
   * any participant may, which is simpler but races more.
   */
  integrationAuthority: string | null
  /** Whether integration may run project-defined build and test commands. */
  allowValidationCommands: boolean
}

export const DEFAULT_COLLAB_SETTINGS: CollabSettings = {
  syncIntervalSeconds: 10,
  reservationLeaseSeconds: 30 * 60,
  integrationAuthority: null,
  allowValidationCommands: false
}

export interface Developer extends Revisioned {
  id: string
  displayName: string
  /** `user.name <user.email>` from Git config. Attribution only. */
  gitIdentity: string
  /** ISO 8601 of the last activity checkpoint this developer published. */
  lastSeenAt: string
  /** Module the developer currently has selected, when they chose to share it. */
  focusModuleId: ModuleId | null
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Task lifecycle.
 *
 * `planning` → `coding` → `testing` are reported by the agent as it works;
 * `review` means changes are on a branch awaiting integration. `conflict` is
 * set by integration, not by the agent, so an agent cannot mark its own work
 * safe.
 */
export type TaskStatus =
  | 'open'
  | 'planning'
  | 'coding'
  | 'testing'
  | 'review'
  | 'conflict'
  | 'completed'
  | 'abandoned'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'open',
  'planning',
  'coding',
  'testing',
  'review',
  'conflict',
  'completed',
  'abandoned'
]

/** Statuses meaning "this task is still live". */
export function isActiveTask(status: TaskStatus): boolean {
  return status !== 'completed' && status !== 'abandoned'
}

export interface Task extends Revisioned {
  id: string
  title: string
  description: string
  /** Modules this task is allowed to change. Also its write scope. */
  moduleIds: ModuleId[]
  assignedDeveloper: string | null
  assignedAgent: string | null
  status: TaskStatus
  /** Branch the work lives on, e.g. `agent/task-102`. */
  branch: string | null
  /** Commit on the integrated branch the work started from. */
  baseCommit: string | null
  /** `ArchitectureGraph.version` the task was created against. */
  graphVersion: number
  createdAt: string
  createdBy: string
  /** Set when integration finishes, successfully or not. */
  closedAt: string | null
}

// ---------------------------------------------------------------------------
// Module reservations
// ---------------------------------------------------------------------------

/**
 * An advisory claim on a module.
 *
 * Deliberately a *lease*, not a lock: an abandoned task must not keep a module
 * reserved forever. Enforcement is local write-scope checking plus validation
 * at integration time — Git metadata is not a filesystem security boundary,
 * and this type should never be mistaken for one.
 */
export interface ModuleReservation extends Revisioned {
  moduleId: ModuleId
  taskId: string
  /** Developer who holds it. */
  owner: string
  acquiredAt: string
  /** ISO 8601. Past this, the reservation is stale and may be taken over. */
  expiresAt: string
}

export function isReservationExpired(
  reservation: ModuleReservation,
  now = Date.now()
): boolean {
  const expires = Date.parse(reservation.expiresAt)
  return Number.isFinite(expires) && expires < now
}

// ---------------------------------------------------------------------------
// Agent sessions
// ---------------------------------------------------------------------------

export type AgentSessionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'awaiting_review'
  | 'offline'
  | 'finished'
  | 'failed'

/**
 * Which machine is actually executing a session.
 *
 * A session belongs to the project and the task, so any developer can watch it
 * and queue instructions — but only the host that owns the worktree runs it.
 * `hostId` is a random per-install id, not a hostname, so nothing identifying
 * leaves the machine.
 */
export interface ExecutionHost {
  hostId: string
  /** Developer running that install, for display. */
  developerId: string
  /** ISO 8601. Used to decide whether the host has gone away. */
  lastHeartbeatAt: string
}

export type ActivityKind =
  | 'started'
  | 'plan'
  | 'tool'
  | 'progress'
  | 'files_changed'
  | 'validation'
  | 'commit'
  | 'instruction_received'
  | 'error'
  | 'finished'

/**
 * One checkpoint in a session's history.
 *
 * Checkpoints, not tokens: streaming every generated token through Git would
 * produce a useless history and an enormous branch. Only events another
 * developer would want to see are published.
 */
export interface ActivityEntry {
  id: string
  at: string
  kind: ActivityKind
  message: string
  detail?: string
  /** Files touched, for `files_changed` and `commit`. */
  paths?: string[]
}

export type InstructionStatus = 'pending' | 'accepted' | 'rejected' | 'applied'

/** An instruction queued by any developer, for the host to pick up. */
export interface Instruction {
  id: string
  at: string
  /** Developer who sent it — not necessarily the session's owner. */
  fromDeveloper: string
  text: string
  status: InstructionStatus
  /** Why it was rejected, or which turn applied it. */
  note?: string
}

export interface AgentSession extends Revisioned {
  id: string
  taskId: string
  /** `null` when no host has claimed the session yet. */
  host: ExecutionHost | null
  status: AgentSessionStatus
  /** The branch the agent commits to. */
  branch: string | null
  /** Append-only. Merged by union of ids. */
  activity: ActivityEntry[]
  /** Append-only. Merged by union of ids, with status taken from the host. */
  instructions: Instruction[]
  /** Commits the agent has produced on its branch. */
  commits: string[]
  startedAt: string | null
  finishedAt: string | null
}

/**
 * `true` when a session claims to be running but its host has stopped
 * checking in, so the UI must not present it as live.
 */
export function isHostStale(
  session: AgentSession,
  staleAfterMs: number,
  now = Date.now()
): boolean {
  if (!session.host) return session.status === 'running'
  const last = Date.parse(session.host.lastHeartbeatAt)
  return Number.isFinite(last) ? now - last > staleAfterMs : true
}

// ---------------------------------------------------------------------------
// Architecture operations
// ---------------------------------------------------------------------------

export type OperationStatus =
  | 'proposed'
  | 'accepted'
  | 'conflicted'
  | 'implemented'
  | 'withdrawn'

/**
 * A structural graph edit, published for others to see and reconcile.
 *
 * Structural edits go through here; *layout* changes never do. Rearranging
 * nodes must not produce a merge conflict or a source change, so positions
 * stay local (see `GraphLayout`) and are not part of collaboration state.
 */
export interface ArchitectureOperationRecord extends Revisioned {
  id: string
  /** The task this edit belongs to, when it was made for one. */
  taskId: string | null
  /** `ArchitectureGraph.version` the edit was authored against. */
  baseGraphVersion: number
  /** The edit itself, reusing the existing operation union. */
  operation: GraphOperation
  status: OperationStatus
  author: string
  /** Set when the operation conflicts with another. */
  conflictWith: string[]
  conflictReason: string | null
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

export type ConflictKind =
  | 'file'
  | 'interface'
  | 'data_structure'
  | 'contract'
  | 'shared_config'

export type ConflictSeverity = 'blocking' | 'warning'

/**
 * One detected incompatibility.
 *
 * `severity` separates what is known from what is suspected: a Git-level
 * overlap is a fact, while a contract incompatibility is usually an inference.
 * The UI must keep that distinction — presenting a suspicion as proof teaches
 * users to ignore the warnings.
 */
export interface IntegrationConflict {
  kind: ConflictKind
  severity: ConflictSeverity
  /** One-line summary, e.g. `Authentication.validateToken() changed`. */
  summary: string
  /** Architectural explanation, including who depends on what. */
  explanation: string
  paths: string[]
  /** Modules whose code may stop working. */
  affectedModuleIds: ModuleId[]
  symbolIds: string[]
  /** Tasks whose work this collides with, when known. */
  withTaskIds: string[]
}

export type IntegrationStatus =
  | 'queued'
  | 'validating'
  | 'conflicted'
  | 'ready'
  | 'merged'
  | 'rejected'
  | 'failed'

export interface ValidationOutcome {
  /** `typecheck`, `test`, `build`. */
  name: string
  status: 'passed' | 'failed' | 'skipped' | 'not_run'
  /** Why it was skipped or could not run — never conflated with a failure. */
  message: string
  durationMs: number
}

export interface IntegrationRequest extends Revisioned {
  id: string
  taskId: string
  sourceBranch: string
  targetBranch: string
  /** Head of the source branch when the request was submitted. */
  sourceCommit: string
  /** Head of the target branch it was validated against. */
  targetCommit: string
  status: IntegrationStatus
  conflicts: IntegrationConflict[]
  validations: ValidationOutcome[]
  /** Files the task changed, project-relative POSIX. */
  changedPaths: string[]
  /** Paths the task changed that lay outside its reserved modules. */
  outOfScopePaths: string[]
  mergeCommit: string | null
  submittedAt: string
  submittedBy: string
  resolvedAt: string | null
  note: string | null
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type CollabEventKind =
  | 'project_initialized'
  | 'developer_joined'
  | 'task_created'
  | 'task_status_changed'
  | 'agent_assigned'
  | 'agent_started'
  | 'module_reserved'
  | 'module_released'
  | 'reservation_expired'
  | 'instruction_sent'
  | 'architecture_changed'
  | 'integration_submitted'
  | 'integration_merged'
  | 'conflict_detected'

/** Append-only shared timeline. Merged by union of ids. */
export interface CollabEvent {
  id: string
  at: string
  kind: CollabEventKind
  actor: string
  message: string
  taskId?: string
  moduleIds?: ModuleId[]
}

// ---------------------------------------------------------------------------
// The whole state
// ---------------------------------------------------------------------------

/**
 * Everything on the coordination branch, as one value.
 *
 * Stored as several files so that two clones editing different entity kinds do
 * not even touch the same blob; see `core/collab/layout.ts`. Reassembled here
 * because every consumer wants it whole.
 */
export interface ProjectState {
  schemaVersion: number
  project: CollabProject
  developers: Developer[]
  tasks: Task[]
  reservations: ModuleReservation[]
  sessions: AgentSession[]
  operations: ArchitectureOperationRecord[]
  integrations: IntegrationRequest[]
  events: CollabEvent[]
}

export function emptyProjectState(project: CollabProject): ProjectState {
  return {
    schemaVersion: COLLAB_SCHEMA_VERSION,
    project,
    developers: [],
    tasks: [],
    reservations: [],
    sessions: [],
    operations: [],
    integrations: [],
    events: []
  }
}

// --- lookups ---------------------------------------------------------------

export function findTask(state: ProjectState, taskId: string): Task | null {
  return state.tasks.find((t) => t.id === taskId) ?? null
}

export function findSessionForTask(
  state: ProjectState,
  taskId: string
): AgentSession | null {
  return state.sessions.find((s) => s.taskId === taskId) ?? null
}

export function reservationFor(
  state: ProjectState,
  moduleId: ModuleId
): ModuleReservation | null {
  return state.reservations.find((r) => r.moduleId === moduleId) ?? null
}

/** Live reservations only — expired leases are treated as absent. */
export function activeReservations(
  state: ProjectState,
  now = Date.now()
): ModuleReservation[] {
  return state.reservations.filter((r) => !isReservationExpired(r, now))
}

export function tasksForModule(state: ProjectState, moduleId: ModuleId): Task[] {
  return state.tasks.filter(
    (t) => t.moduleIds.includes(moduleId) && isActiveTask(t.status)
  )
}
