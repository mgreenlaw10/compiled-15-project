/**
 * The collaboration provider interface.
 *
 * Everything above this line — IPC handlers, the store, the graph — talks to a
 * `CollaborationProvider` and knows nothing about Git. That is the seam the
 * brief asks for: a future WebSocket or database implementation replaces
 * `GitCollaborationProvider` without the graph editor or the agent
 * orchestration changing.
 *
 * The interface is shaped around what Git can honestly offer:
 *
 *   - `getProjectState` is a *local cached read*. It never touches the network,
 *     so the UI keeps working offline.
 *   - `synchronize` is the only networked call, and it reports what it actually
 *     achieved. Nothing here may claim a remote operation succeeded before Git
 *     has confirmed it.
 *   - `submitOperation` applies locally and queues for the next publish, so a
 *     user's edit is never lost to a failed push.
 */

import type { ModuleId } from '../../shared/types/architecture'
import type {
  ActivityEntry,
  AgentSession,
  CollabEvent,
  Developer,
  Instruction,
  IntegrationRequest,
  ModuleReservation,
  ProjectState,
  Task,
  TaskStatus
} from '../../shared/collab'

/**
 * A change to collaboration state, as a value.
 *
 * Operations are data rather than method calls so they can sit in a durable
 * queue across a restart, be replayed after reconnection, and be merged
 * against someone else's concurrent work.
 */
export type CollaborationOperation =
  | { kind: 'upsert_developer'; developer: Omit<Developer, keyof RevisionFields> }
  | { kind: 'create_task'; task: NewTask }
  | {
      kind: 'update_task'
      taskId: string
      changes: Partial<
        Pick<
          Task,
          | 'title'
          | 'description'
          | 'status'
          | 'assignedAgent'
          | 'assignedDeveloper'
          | 'branch'
          | 'baseCommit'
          | 'moduleIds'
          | 'closedAt'
        >
      >
    }
  | { kind: 'claim_module'; moduleId: ModuleId; taskId: string; leaseSeconds?: number }
  | { kind: 'release_module'; moduleId: ModuleId }
  | { kind: 'renew_reservation'; moduleId: ModuleId; leaseSeconds?: number }
  | { kind: 'upsert_session'; session: SessionPatch }
  | { kind: 'append_activity'; sessionId: string; entries: ActivityEntry[] }
  | { kind: 'queue_instruction'; sessionId: string; text: string }
  | {
      kind: 'resolve_instruction'
      sessionId: string
      instructionId: string
      status: Instruction['status']
      note?: string
    }
  | { kind: 'upsert_integration'; request: IntegrationPatch }
  | { kind: 'record_event'; event: Omit<CollabEvent, 'id' | 'at' | 'actor'> }

type RevisionFields = 'revision' | 'updatedAt' | 'updatedBy'

export interface NewTask {
  /** Omit to have one generated. */
  id?: string
  title: string
  description: string
  moduleIds: ModuleId[]
  assignedDeveloper?: string | null
  assignedAgent?: string | null
  status?: TaskStatus
  graphVersion: number
  baseCommit?: string | null
}

export type SessionPatch = { id: string; taskId: string } & Partial<
  Omit<AgentSession, 'id' | 'taskId' | keyof RevisionFields>
>

export type IntegrationPatch = { id: string; taskId: string } & Partial<
  Omit<IntegrationRequest, 'id' | 'taskId' | keyof RevisionFields>
>

/** What one `synchronize()` actually did. Never optimistic. */
export interface SyncReport {
  /** `true` when the remote was reached. `false` means purely local work. */
  online: boolean
  /** Commit of the coordination branch now held locally. */
  stateCommit: string | null
  /** Operations published to the remote in this pass. */
  published: number
  /** Operations still queued, because publishing failed or was offline. */
  queued: number
  /** How many times a push was rejected and retried. */
  retries: number
  /** Entities where a concurrent edit was reconciled. */
  contested: { kind: string; id: string }[]
  /** Reservations whose lease had run out and were dropped. */
  expiredReservations: ModuleId[]
  /** Set when synchronization could not complete. */
  error: string | null
  at: string
}

/** Whether what the client holds is fresh enough to present as current. */
export interface Freshness {
  lastSyncAt: string | null
  /** `true` when the last successful sync is older than the staleness window. */
  stale: boolean
  /** Pending local operations not yet on the remote. */
  queued: number
  online: boolean
}

export interface CollaborationProvider {
  /** Attaches to a project. Does not require the network. */
  connect(): Promise<void>
  disconnect(): Promise<void>

  /** The locally cached state. Synchronous in spirit: no network. */
  getProjectState(): ProjectState

  getFreshness(): Freshness

  /**
   * Applies an operation locally and queues it for publication. Resolves once
   * it is durable locally — not once it has reached the remote.
   */
  submitOperation(operation: CollaborationOperation): Promise<void>

  /** Fetch, merge, publish, retry. The only networked call. */
  synchronize(): Promise<SyncReport>

  getTasks(): Task[]
  getAgentSessions(): AgentSession[]
  getReservations(): ModuleReservation[]
}
