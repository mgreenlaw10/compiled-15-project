/**
 * What a module's collaboration state is, derived rather than stored.
 *
 * Deriving it matters: a stored status would be one more thing two clones can
 * disagree about, and it would go stale the moment a lease expired. Computing
 * it from tasks, reservations and sessions means the graph cannot show
 * "Coding" for an agent whose host died twenty minutes ago.
 *
 * Staleness is first-class. `stale` is not a kind of work — it means the client
 * has not synchronized recently enough to claim it knows, and the UI must say
 * so rather than presenting old data as current.
 */

import type { ModuleId } from '../types/architecture'
import {
  findSessionForTask,
  isActiveTask,
  isHostStale,
  isReservationExpired,
  type AgentSession,
  type ModuleReservation,
  type ProjectState,
  type Task
} from './model'

export type ModuleStatus =
  | 'available'
  | 'reserved'
  | 'planning'
  | 'coding'
  | 'testing'
  | 'review'
  | 'conflict'
  | 'completed'
  | 'stale'

/** Display order, roughly "needs attention" first. */
export const MODULE_STATUS_ORDER: readonly ModuleStatus[] = [
  'conflict',
  'review',
  'testing',
  'coding',
  'planning',
  'reserved',
  'completed',
  'available',
  'stale'
]

export interface ModuleStatusLabel {
  label: string
  /** CSS custom property or hex, matching the canvas legend. */
  color: string
  /** One line explaining what the status means, for a tooltip. */
  meaning: string
}

export const MODULE_STATUS_LABELS: Record<ModuleStatus, ModuleStatusLabel> = {
  available: {
    label: 'Available',
    color: 'var(--text-faint)',
    meaning: 'No active task is assigned.'
  },
  reserved: {
    label: 'Reserved',
    color: 'var(--accent)',
    meaning: 'Claimed for a task, but no agent is running yet.'
  },
  planning: {
    label: 'Planning',
    color: 'var(--ai)',
    meaning: 'An agent is analyzing the task.'
  },
  coding: {
    label: 'Coding',
    color: 'var(--ai)',
    meaning: 'An agent is modifying source code.'
  },
  testing: {
    label: 'Testing',
    color: 'var(--ai)',
    meaning: 'An agent is validating its changes.'
  },
  review: {
    label: 'Review',
    color: 'var(--warn)',
    meaning: 'Changes are awaiting integration.'
  },
  conflict: {
    label: 'Conflict',
    color: 'var(--danger)',
    meaning: 'A potentially incompatible change was detected.'
  },
  completed: {
    label: 'Completed',
    color: 'var(--success)',
    meaning: "The task's changes have been integrated."
  },
  stale: {
    label: 'Unknown',
    color: 'var(--text-faint)',
    meaning:
      'Collaboration metadata has not been refreshed recently enough to confirm this.'
  }
}

/** Statuses that mean someone else is mid-flight and should not be disturbed. */
export function isBusyStatus(status: ModuleStatus): boolean {
  return (
    status === 'planning' ||
    status === 'coding' ||
    status === 'testing' ||
    status === 'review'
  )
}

export interface ModuleCollabState {
  moduleId: ModuleId
  status: ModuleStatus
  /** The task driving the status, when there is one. */
  task: Task | null
  session: AgentSession | null
  reservation: ModuleReservation | null
  developer: string | null
  agent: string | null
  /** `true` when the reservation's lease has run out. */
  reservationExpired: boolean
  /** `true` when the session claims to run but its host stopped checking in. */
  hostStale: boolean
  /** `true` when this module may be claimed for new work. */
  claimable: boolean
}

/** Maps a task's status onto what the graph should show for its modules. */
function statusFromTask(task: Task): ModuleStatus {
  switch (task.status) {
    case 'planning':
      return 'planning'
    case 'coding':
      return 'coding'
    case 'testing':
      return 'testing'
    case 'review':
      return 'review'
    case 'conflict':
      return 'conflict'
    case 'completed':
      return 'completed'
    case 'open':
      return 'reserved'
    default:
      return 'available'
  }
}

export interface StatusOptions {
  now?: number
  /**
   * How long a session host may go quiet before its status is untrustworthy.
   * Should be a small multiple of the heartbeat interval.
   */
  hostStaleAfterMs?: number
  /**
   * `true` when the client's own view of the shared state is too old to
   * present as current. Forces `stale` for everything, because reporting
   * confident statuses from unsynchronized data is worse than admitting it.
   */
  viewIsStale?: boolean
}

const DEFAULT_HOST_STALE_MS = 3 * 60 * 1000

export function moduleCollabState(
  state: ProjectState,
  moduleId: ModuleId,
  options: StatusOptions = {}
): ModuleCollabState {
  const now = options.now ?? Date.now()
  const hostStaleAfterMs = options.hostStaleAfterMs ?? DEFAULT_HOST_STALE_MS

  const reservation = state.reservations.find((r) => r.moduleId === moduleId) ?? null
  const expired = reservation ? isReservationExpired(reservation, now) : false

  // The reservation names the authoritative task; otherwise fall back to any
  // active task that lists this module, so a task created without a claim is
  // still visible on the graph.
  const reservedTask = reservation
    ? (state.tasks.find((t) => t.id === reservation.taskId) ?? null)
    : null
  const candidates = state.tasks.filter(
    (t) => t.moduleIds.includes(moduleId) && isActiveTask(t.status)
  )
  const task =
    reservedTask && isActiveTask(reservedTask.status)
      ? reservedTask
      : (pickMostUrgent(candidates) ?? null)

  const session = task ? findSessionForTask(state, task.id) : null
  const hostStale = session ? isHostStale(session, hostStaleAfterMs, now) : false

  let status: ModuleStatus
  if (options.viewIsStale) {
    status = 'stale'
  } else if (!task) {
    // A completed task still worth showing, if nothing active replaced it.
    const done = state.tasks.find(
      (t) => t.moduleIds.includes(moduleId) && t.status === 'completed'
    )
    status = done ? 'completed' : 'available'
  } else if (task.status === 'conflict') {
    status = 'conflict'
  } else if (hostStale && isBusyStatus(statusFromTask(task))) {
    // The task says "coding" but nobody is home: do not claim it is running.
    status = 'stale'
  } else if (expired && task.status === 'open') {
    status = 'available'
  } else {
    status = statusFromTask(task)
  }

  const claimable =
    status === 'available' ||
    status === 'completed' ||
    status === 'stale' ||
    (expired && !isBusyStatus(status))

  return {
    moduleId,
    status,
    task,
    session,
    reservation,
    developer: task?.assignedDeveloper ?? reservation?.owner ?? null,
    agent: task?.assignedAgent ?? null,
    reservationExpired: expired,
    hostStale,
    claimable
  }
}

/** The task whose status most deserves the node's attention. */
function pickMostUrgent(tasks: Task[]): Task | undefined {
  if (tasks.length <= 1) return tasks[0]
  const rank = (task: Task): number =>
    MODULE_STATUS_ORDER.indexOf(statusFromTask(task))
  return [...tasks].sort((a, b) => rank(a) - rank(b))[0]
}

/** Collaboration state for every module in one pass. */
export function allModuleCollabStates(
  state: ProjectState,
  moduleIds: readonly ModuleId[],
  options: StatusOptions = {}
): Map<ModuleId, ModuleCollabState> {
  return new Map(
    moduleIds.map((id) => [id, moduleCollabState(state, id, options)])
  )
}
