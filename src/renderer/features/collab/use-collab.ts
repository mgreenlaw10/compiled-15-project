/**
 * Collaboration selectors.
 *
 * Hooks rather than plain selectors, for the reason documented in
 * `state/selectors.ts`: a zustand selector that builds a new object re-renders
 * forever. Subscribing to raw slices and deriving with `useMemo` keeps the
 * reference stable.
 *
 * Every derived value here honours staleness. When the client has not
 * synchronized recently enough to trust what it holds, module statuses come
 * back as `stale` rather than as confident claims about what other people's
 * agents are doing.
 */

import { useMemo } from 'react'

import type { ModuleId } from '../../../shared/types/architecture'
import {
  allModuleCollabStates,
  isHostStale,
  isReservationExpired,
  moduleCollabState,
  type AgentSession,
  type Developer,
  type IntegrationRequest,
  type ModuleCollabState,
  type Task
} from '../../../shared/collab'
import { useStore } from '../../state/store'

/** `true` when this project has collaboration switched on. */
export function useCollabEnabled(): boolean {
  return useStore((s) => s.collab !== null)
}

export function useCollabStale(): boolean {
  return useStore((s) => s.collab?.sync.stale ?? false)
}

/** Collaboration state for every module on the canvas. */
export function useModuleStates(): Map<ModuleId, ModuleCollabState> {
  const snapshot = useStore((s) => s.collab)
  const graph = useStore((s) => s.desired)

  return useMemo(() => {
    if (!snapshot || !graph) return new Map<ModuleId, ModuleCollabState>()
    return allModuleCollabStates(
      snapshot.state,
      graph.modules.map((m) => m.id),
      { viewIsStale: snapshot.sync.stale }
    )
  }, [snapshot, graph])
}

/** Collaboration state for one module. */
export function useModuleState(moduleId: ModuleId | null): ModuleCollabState | null {
  const snapshot = useStore((s) => s.collab)
  return useMemo(() => {
    if (!snapshot || !moduleId) return null
    return moduleCollabState(snapshot.state, moduleId, {
      viewIsStale: snapshot.sync.stale
    })
  }, [snapshot, moduleId])
}

export function useTasks(): Task[] {
  const snapshot = useStore((s) => s.collab)
  return useMemo(() => snapshot?.state.tasks ?? [], [snapshot])
}

export function useActiveTasks(): Task[] {
  const tasks = useTasks()
  return useMemo(
    () => tasks.filter((t) => t.status !== 'completed' && t.status !== 'abandoned'),
    [tasks]
  )
}

export function useSessions(): AgentSession[] {
  const snapshot = useStore((s) => s.collab)
  return useMemo(() => snapshot?.state.sessions ?? [], [snapshot])
}

export function useIntegrations(): IntegrationRequest[] {
  const snapshot = useStore((s) => s.collab)
  return useMemo(() => snapshot?.state.integrations ?? [], [snapshot])
}

/** Task worktrees that exist on *this* machine. Local paths, never shared. */
export function useLocalWorktrees(): { taskId: string; path: string }[] {
  const snapshot = useStore((s) => s.collab)
  return useMemo(() => snapshot?.worktrees ?? [], [snapshot])
}

export function useDevelopers(): Developer[] {
  const snapshot = useStore((s) => s.collab)
  return useMemo(() => snapshot?.state.developers ?? [], [snapshot])
}

/** This install's developer id, for "is this mine?" checks. */
export function useMyDeveloperId(): string | null {
  return useStore((s) => s.collabWorkspace?.developerId ?? null)
}

export interface SessionView {
  session: AgentSession
  task: Task | null
  /** `true` when the host stopped checking in, so "running" is not credible. */
  hostStale: boolean
  pendingInstructions: number
}

/** Sessions with their task and an honest liveness flag. */
export function useSessionViews(): SessionView[] {
  const snapshot = useStore((s) => s.collab)
  return useMemo(() => {
    if (!snapshot) return []
    return snapshot.state.sessions.map((session) => ({
      session,
      task: snapshot.state.tasks.find((t) => t.id === session.taskId) ?? null,
      hostStale: isHostStale(session, 3 * 60 * 1000),
      pendingInstructions: session.instructions.filter((i) => i.status === 'pending')
        .length
    }))
  }, [snapshot])
}

export function useSessionForTask(taskId: string | null): AgentSession | null {
  const sessions = useSessions()
  return useMemo(
    () => (taskId ? (sessions.find((s) => s.taskId === taskId) ?? null) : null),
    [sessions, taskId]
  )
}

/** Live reservations, by module. Expired leases are treated as absent. */
export function useReservedModules(): Set<ModuleId> {
  const snapshot = useStore((s) => s.collab)
  return useMemo(() => {
    const ids = new Set<ModuleId>()
    for (const reservation of snapshot?.state.reservations ?? []) {
      if (!isReservationExpired(reservation)) ids.add(reservation.moduleId)
    }
    return ids
  }, [snapshot])
}

/**
 * Modules that depend on, or are depended on by, a module someone else is
 * actively changing.
 *
 * Sharing a dependency is not a conflict and must not be drawn as one — this
 * only marks the modules worth *watching*, which is what the brief asks for:
 * maximize useful parallelism, flag what might become incompatible.
 */
export function useDependencyWarnings(): Map<ModuleId, string> {
  const snapshot = useStore((s) => s.collab)
  const graph = useStore((s) => s.desired)
  const myId = useMyDeveloperId()

  return useMemo(() => {
    const warnings = new Map<ModuleId, string>()
    if (!snapshot || !graph) return warnings

    const busyByModule = new Map<ModuleId, Task>()
    for (const task of snapshot.state.tasks) {
      if (!['planning', 'coding', 'testing', 'review'].includes(task.status)) continue
      for (const moduleId of task.moduleIds) busyByModule.set(moduleId, task)
    }
    if (busyByModule.size === 0) return warnings

    const nameOf = (id: ModuleId): string =>
      graph.modules.find((m) => m.id === id)?.name ?? id

    for (const edge of graph.edges) {
      const busyFrom = busyByModule.get(edge.from)
      const busyTo = busyByModule.get(edge.to)

      // `edge.from` depends on `edge.to`, so work in `to` is what threatens
      // `from` — an interface change upstream breaks the consumer.
      if (busyTo && !busyByModule.has(edge.from)) {
        const who =
          busyTo.assignedDeveloper === myId ? 'you' : (busyTo.assignedDeveloper ?? 'someone')
        warnings.set(
          edge.from,
          `Depends on ${nameOf(edge.to)}, which ${who} ${
            busyTo.assignedAgent ? `and ${busyTo.assignedAgent} ` : ''
          }are changing ("${busyTo.title}"). An interface change there would affect this module.`
        )
      }
      if (busyFrom && busyTo && busyFrom.id !== busyTo.id) {
        warnings.set(
          edge.to,
          `${nameOf(edge.from)} depends on this module, and both are being changed at once (${busyFrom.id} and ${busyTo.id}).`
        )
      }
    }
    return warnings
  }, [snapshot, graph, myId])
}

/** One line for the status bar, honest about staleness. */
export function useCollabSummary(): string | null {
  const snapshot = useStore((s) => s.collab)
  const tasks = useActiveTasks()
  const sessions = useSessions()

  return useMemo(() => {
    if (!snapshot) return null
    const running = sessions.filter((s) => s.status === 'running').length
    const parts: string[] = []
    if (tasks.length > 0) parts.push(`${tasks.length} active task(s)`)
    if (running > 0) parts.push(`${running} agent(s) running`)
    if (snapshot.sync.queued > 0) {
      parts.push(`${snapshot.sync.queued} change(s) not yet shared`)
    }
    if (parts.length === 0) parts.push('collaborating')

    if (snapshot.sync.stale) return `${parts.join(', ')} — not synchronized recently`
    if (!snapshot.sync.online) return `${parts.join(', ')} — offline`
    return parts.join(', ')
  }, [snapshot, tasks, sessions])
}
