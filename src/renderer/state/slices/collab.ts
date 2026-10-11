/**
 * Collaboration state, as the renderer sees it.
 *
 * A cache of what the backend last told us, plus the actions that change it.
 * Deliberately *not* a source of truth: every mutation goes to the backend,
 * which publishes it through Git, and the snapshot that comes back is what the
 * UI draws. That keeps one copy of the merge logic rather than a hopeful
 * optimistic one here and the real one there.
 *
 * `sync.stale` is surfaced rather than hidden. When the client has not
 * synchronized recently enough to trust what it holds, the graph says so
 * instead of showing confident statuses from old data.
 */

import type {
  CollabSnapshot,
  CreateTaskRequest,
  IntegrationReport,
  SyncStatus,
  WorkspaceStatus
} from '../../../shared/ipc'
import type { ModuleId } from '../../../shared/types/architecture'
import type { CollabSlice, Slice } from '../types'

export const createCollabSlice: Slice<CollabSlice> = (set, get) => ({
  collab: null,
  collabWorkspace: null,
  collabBusy: false,
  collabError: null,
  selectedTaskId: null,
  integrationReports: {},

  async inspectWorkspace() {
    const project = get().project
    if (!project) return
    try {
      const workspace = await window.cartograph.inspectWorkspace(project.root)
      set({ collabWorkspace: workspace })
    } catch (error) {
      set({ collabError: (error as Error).message })
    }
  },

  async initializeCollaboration(remoteUrl) {
    const project = get().project
    if (!project) return
    set({ collabBusy: true, collabError: null })
    try {
      const workspace: WorkspaceStatus =
        await window.cartograph.initializeCollaboration({
          root: project.root,
          projectName: project.name,
          ...(remoteUrl ? { remoteUrl } : {})
        })
      set({ collabWorkspace: workspace, collabBusy: false })
      await get().connectCollaboration()
    } catch (error) {
      set({ collabBusy: false, collabError: (error as Error).message })
    }
  },

  async joinCollaboration() {
    const project = get().project
    if (!project) return
    set({ collabBusy: true, collabError: null })
    try {
      const workspace = await window.cartograph.joinCollaboration(project.root)
      set({ collabWorkspace: workspace, collabBusy: false })
      await get().connectCollaboration()
    } catch (error) {
      set({ collabBusy: false, collabError: (error as Error).message })
    }
  },

  async connectCollaboration() {
    const project = get().project
    if (!project) return
    set({ collabBusy: true, collabError: null })
    try {
      const snapshot = await window.cartograph.connect(project.root)
      set({
        collab: snapshot,
        collabWorkspace: snapshot.workspace,
        collabBusy: false
      })
    } catch (error) {
      set({ collabBusy: false, collabError: (error as Error).message })
    }
  },

  async disconnectCollaboration() {
    try {
      await window.cartograph.disconnect()
    } finally {
      set({ collab: null, selectedTaskId: null })
    }
  },

  /** Called by the push subscription, so a remote change needs no round trip. */
  receiveSnapshot(snapshot: CollabSnapshot) {
    set({ collab: snapshot, collabWorkspace: snapshot.workspace })
  },

  async syncCollaboration() {
    if (!get().collab) return
    set({ collabBusy: true })
    try {
      const snapshot = await window.cartograph.synchronize()
      set({ collab: snapshot, collabWorkspace: snapshot.workspace, collabBusy: false })
      // A sync that could not reach the remote is reported, not swallowed:
      // the user needs to know the view they are looking at is cached.
      set({ collabError: snapshot.sync.error })
    } catch (error) {
      set({ collabBusy: false, collabError: (error as Error).message })
    }
  },

  async createTask(request: Omit<CreateTaskRequest, 'graphVersion'>) {
    const graph = get().desired
    if (!graph) return null
    set({ collabBusy: true, collabError: null })
    try {
      const task = await window.cartograph.createTask({
        ...request,
        graphVersion: graph.version
      })
      set({ collabBusy: false, selectedTaskId: task.id })
      await get().syncCollaboration()
      return task
    } catch (error) {
      set({ collabBusy: false, collabError: (error as Error).message })
      return null
    }
  },

  async claimModule(moduleId: ModuleId, taskId: string) {
    try {
      await window.cartograph.claimModule({ moduleId, taskId })
      await get().syncCollaboration()
    } catch (error) {
      set({ collabError: (error as Error).message })
    }
  },

  async releaseModule(moduleId: ModuleId) {
    try {
      await window.cartograph.releaseModule(moduleId)
      await get().syncCollaboration()
    } catch (error) {
      set({ collabError: (error as Error).message })
    }
  },

  async startAgent(taskId: string) {
    set({ collabBusy: true, collabError: null })
    try {
      const result = await window.cartograph.startAgent({ taskId })
      set({ collabBusy: false })
      if (!result.started) set({ notice: result.message })
      else set({ notice: result.message, bottomTab: 'agents' })
      await get().syncCollaboration()
    } catch (error) {
      set({ collabBusy: false, collabError: (error as Error).message })
    }
  },

  async cancelAgent(taskId: string) {
    try {
      await window.cartograph.cancelAgent(taskId)
      await get().syncCollaboration()
    } catch (error) {
      set({ collabError: (error as Error).message })
    }
  },

  async sendInstruction(sessionId: string, text: string) {
    if (text.trim() === '') return
    try {
      await window.cartograph.sendInstruction({ sessionId, text: text.trim() })
      await get().syncCollaboration()
    } catch (error) {
      set({ collabError: (error as Error).message })
    }
  },

  async assessIntegration(taskId: string) {
    set({ collabBusy: true, collabError: null })
    try {
      const report = await window.cartograph.assessIntegration({ taskId })
      set((state) => ({
        collabBusy: false,
        integrationReports: { ...state.integrationReports, [taskId]: report }
      }))
      return report
    } catch (error) {
      set({ collabBusy: false, collabError: (error as Error).message })
      return null
    }
  },

  async submitIntegration(taskId: string) {
    set({ collabBusy: true, collabError: null })
    try {
      const report = await window.cartograph.submitIntegration({ taskId })
      set((state) => ({
        collabBusy: false,
        integrationReports: { ...state.integrationReports, [taskId]: report }
      }))
      await get().syncCollaboration()
      return report
    } catch (error) {
      set({ collabBusy: false, collabError: (error as Error).message })
      return null
    }
  },

  async integrateTask(taskId: string) {
    set({ collabBusy: true, collabError: null })
    try {
      const report: IntegrationReport = await window.cartograph.integrateTask({
        taskId
      })
      set((state) => ({
        collabBusy: false,
        integrationReports: { ...state.integrationReports, [taskId]: report },
        notice:
          report.status === 'merged'
            ? `Integrated the task into the shared branch. ${report.note ?? ''}`.trim()
            : null,
        collabError:
          report.status === 'merged' ? null : (report.note ?? 'Integration did not complete.')
      }))
      await get().syncCollaboration()
      // The integrated branch moved, so the observed architecture is stale.
      if (report.status === 'merged') await get().analyze({ useAi: false, force: true })
      return report
    } catch (error) {
      set({ collabBusy: false, collabError: (error as Error).message })
      return null
    }
  },

  selectTask(taskId: string | null) {
    set({ selectedTaskId: taskId })
  },

  setCollabError(message: string | null) {
    set({ collabError: message })
  }
})

/** `null` when collaboration is off, so callers can branch on it cheaply. */
export function syncStatusOf(snapshot: CollabSnapshot | null): SyncStatus | null {
  return snapshot?.sync ?? null
}
