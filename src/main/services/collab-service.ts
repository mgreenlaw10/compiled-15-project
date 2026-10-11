/**
 * The collaboration service: one live provider per open project.
 *
 * Holds the state the IPC layer needs between calls — which project is open,
 * its provider, the agents currently running — and owns the periodic
 * synchronization timer. Keeping it here rather than in the IPC module means
 * the handlers stay thin adapters and the lifecycle is testable without
 * Electron.
 *
 * Polling is deliberately modest and read-biased: fetching the coordination
 * branch every few seconds is cheap, but *writing* it is not, so presence is
 * published on activity checkpoints rather than on a timer. Committing every
 * few seconds just to say "still here" would turn the branch into thousands of
 * useless commits.
 */

import type { ArchitectureGraph } from '../../shared/types/architecture'
import type { AgentSession, ProjectState, Task } from '../../shared/collab'
import type { CollabSnapshot, SyncStatus, WorkspaceStatus } from '../../shared/ipc'
import type { AiConfig } from '../../shared/ai'
import type { ChannelLogger, Logger } from '../../core/logger'
import { Git } from '../../core/git/git'
import {
  GitCollaborationProvider,
  initializeCollaboration,
  inspectWorkspace,
  joinCollaboration,
  listTaskWorkspaces,
  loadOrCreateIdentity,
  type CollaborationProvider,
  type SyncReport
} from '../../core/collab'
import { runTaskAgent, type RunTaskAgentResult } from '../../core/collab'

export interface CollabServiceDeps {
  logger: Logger
  /** Electron's userData directory, for the per-install identity. */
  userDataDir: string
  /** The model configuration, or `null` when no key is set. */
  getAiConfig: () => Promise<AiConfig | null>
  /** The analyzed graph of the open project, for briefs and conflict analysis. */
  getGraph: () => ArchitectureGraph | null
  /** Called whenever shared state changes, so the renderer can refresh. */
  onChanged: (snapshot: CollabSnapshot) => void
}

interface ActiveProject {
  root: string
  provider: CollaborationProvider
  developerId: string
  hostId: string
  displayName: string
  timer: NodeJS.Timeout | null
  /** Agent runs in flight on this machine, by task id. */
  running: Map<string, { controller: AbortController; sessionId: string }>
}

export class CollabService {
  private active: ActiveProject | null = null
  private readonly log: ChannelLogger
  private lastSync: SyncStatus = {
    online: false,
    lastSyncAt: null,
    stale: true,
    queued: 0,
    stateCommit: null,
    retries: 0,
    contested: [],
    expiredReservations: [],
    error: null
  }

  constructor(private readonly deps: CollabServiceDeps) {
    this.log = deps.logger.child('collab')
  }

  get isConnected(): boolean {
    return this.active !== null
  }

  private requireActive(): ActiveProject {
    if (!this.active) {
      throw new Error('No collaborative project is open. Connect to one first.')
    }
    return this.active
  }

  get provider(): CollaborationProvider {
    return this.requireActive().provider
  }

  // --- workspace lifecycle -------------------------------------------------

  async inspect(root: string): Promise<WorkspaceStatus> {
    const info = await inspectWorkspace(root)
    return {
      ...info,
      connected: this.active?.root === info.root,
      developerId: this.active?.developerId ?? null
    }
  }

  async initialize(options: {
    root: string
    projectName: string
    remoteUrl?: string
  }): Promise<WorkspaceStatus> {
    const git = new Git(options.root)
    const identity = await loadOrCreateIdentity(this.deps.userDataDir, git)
    await initializeCollaboration({
      root: options.root,
      developerId: identity.developerId,
      projectName: options.projectName,
      logger: this.log,
      ...(options.remoteUrl ? { remoteUrl: options.remoteUrl } : {})
    })
    return this.inspect(options.root)
  }

  async join(root: string): Promise<WorkspaceStatus> {
    await joinCollaboration({ root, logger: this.log })
    return this.inspect(root)
  }

  /** Attaches to a project and starts the synchronization timer. */
  async connect(root: string): Promise<CollabSnapshot> {
    if (this.active?.root === root) return this.snapshot()
    await this.disconnect()

    const git = new Git(root)
    const identity = await loadOrCreateIdentity(this.deps.userDataDir, git)

    const provider = new GitCollaborationProvider({
      repoRoot: root,
      developerId: identity.developerId,
      displayName: identity.displayName,
      logger: this.log
    })
    await provider.connect()

    this.active = {
      root,
      provider,
      developerId: identity.developerId,
      hostId: identity.hostId,
      displayName: identity.displayName,
      timer: null,
      running: new Map()
    }

    // Announce ourselves, so other developers see a participant rather than
    // inferring one from task records.
    await provider.submitOperation({
      kind: 'upsert_developer',
      developer: {
        id: identity.developerId,
        displayName: identity.displayName,
        gitIdentity: `${(await git.identity()).name} <${(await git.identity()).email}>`,
        lastSeenAt: new Date().toISOString(),
        focusModuleId: null
      }
    })

    await this.syncNow()
    this.startTimer()
    this.log.success(
      `Collaborating on ${root} as ${identity.displayName} (${identity.developerId})`
    )
    return this.snapshot()
  }

  async disconnect(): Promise<void> {
    const active = this.active
    if (!active) return

    if (active.timer) clearInterval(active.timer)
    for (const [, run] of active.running) run.controller.abort()

    // Mark our sessions offline so nobody waits on an agent that is gone.
    for (const [taskId, run] of active.running) {
      await active.provider
        .submitOperation({
          kind: 'upsert_session',
          session: { id: run.sessionId, taskId, status: 'offline' }
        })
        .catch(() => {})
    }
    await active.provider.synchronize().catch(() => {})
    await active.provider.disconnect()
    this.active = null
  }

  private startTimer(): void {
    const active = this.requireActive()
    const seconds =
      active.provider.getProjectState().project.settings.syncIntervalSeconds || 10
    active.timer = setInterval(() => {
      // Fire-and-forget: a failed pass is reported in the snapshot, and the
      // next tick retries. Never let a timer rejection escape.
      void this.syncNow().catch(() => {})
    }, Math.max(5, seconds) * 1000)
  }

  // --- synchronization -----------------------------------------------------

  async syncNow(): Promise<CollabSnapshot> {
    const active = this.requireActive()
    const report: SyncReport = await active.provider.synchronize()
    const freshness = active.provider.getFreshness()

    this.lastSync = {
      online: report.online,
      lastSyncAt: freshness.lastSyncAt,
      stale: freshness.stale,
      queued: report.queued,
      stateCommit: report.stateCommit,
      retries: report.retries,
      contested: report.contested,
      expiredReservations: report.expiredReservations,
      error: report.error
    }

    if (report.contested.length > 0) {
      this.log.info(
        `Reconciled ${report.contested.length} concurrent change(s) from other developers`
      )
    }
    for (const moduleId of report.expiredReservations) {
      this.log.warn(`The reservation on ${moduleId} expired and was released`)
    }

    const snapshot = await this.snapshot()
    this.deps.onChanged(snapshot)
    return snapshot
  }

  async snapshot(): Promise<CollabSnapshot> {
    const active = this.requireActive()
    return {
      state: active.provider.getProjectState(),
      sync: this.lastSync,
      workspace: await this.inspect(active.root),
      worktrees: await listTaskWorkspaces(active.root)
    }
  }

  // --- tasks ---------------------------------------------------------------

  async createTask(options: {
    title: string
    description: string
    moduleIds: string[]
    assignedAgent?: string | null
    graphVersion: number
    claimModules?: boolean
  }): Promise<Task> {
    const active = this.requireActive()
    const git = new Git(active.root)
    const baseCommit = await git.headCommit()

    const before = new Set(active.provider.getTasks().map((t) => t.id))
    await active.provider.submitOperation({
      kind: 'create_task',
      task: {
        title: options.title,
        description: options.description,
        moduleIds: options.moduleIds,
        assignedAgent: options.assignedAgent ?? null,
        graphVersion: options.graphVersion,
        baseCommit
      }
    })

    const created = active.provider.getTasks().find((t) => !before.has(t.id))
    if (!created) throw new Error('The task could not be created')

    if (options.claimModules !== false) {
      for (const moduleId of options.moduleIds) {
        await active.provider.submitOperation({
          kind: 'claim_module',
          moduleId,
          taskId: created.id
        })
      }
    }

    await this.syncNow()
    // Re-read: a concurrent claim may have changed what we actually hold.
    return active.provider.getTasks().find((t) => t.id === created.id) ?? created
  }

  async updateTask(taskId: string, changes: Partial<Task>): Promise<void> {
    const active = this.requireActive()
    await active.provider.submitOperation({
      kind: 'update_task',
      taskId,
      changes
    })
    await this.syncNow()
  }

  async claimModule(moduleId: string, taskId: string): Promise<void> {
    const active = this.requireActive()
    await active.provider.submitOperation({ kind: 'claim_module', moduleId, taskId })
    await this.syncNow()
  }

  async releaseModule(moduleId: string): Promise<void> {
    const active = this.requireActive()
    await active.provider.submitOperation({ kind: 'release_module', moduleId })
    await this.syncNow()
  }

  // --- agents --------------------------------------------------------------

  /**
   * Starts an agent for a task on this machine.
   *
   * Refuses if this machine is already running that task, and
   * `runTaskAgent` refuses again if another host holds the session — the
   * second check is the one that matters across machines.
   */
  async startAgent(taskId: string): Promise<{
    sessionId: string
    started: boolean
    message: string
  }> {
    const active = this.requireActive()
    if (active.running.has(taskId)) {
      return {
        sessionId: active.running.get(taskId)!.sessionId,
        started: false,
        message: 'An agent is already running for this task on this machine.'
      }
    }

    const task = active.provider.getTasks().find((t) => t.id === taskId)
    if (!task) throw new Error(`No task ${taskId}`)

    const graph = this.deps.getGraph()
    if (!graph) {
      throw new Error('The project has not been analyzed yet, so there is no graph to brief the agent with.')
    }

    const config = await this.deps.getAiConfig()
    const controller = new AbortController()
    active.running.set(taskId, { controller, sessionId: '' })

    // Deliberately not awaited: an agent run is long, and the caller is an IPC
    // handler that must return so the UI stays responsive. Progress arrives
    // through the collaboration state.
    void runTaskAgent({
      repoRoot: active.root,
      task,
      graph,
      config,
      provider: active.provider,
      hostId: active.hostId,
      developerId: active.developerId,
      logger: this.log,
      signal: controller.signal
    })
      .then((result: RunTaskAgentResult) => {
        const entry = active.running.get(taskId)
        if (entry) entry.sessionId = result.sessionId
        this.log.info(`Agent for ${taskId} finished: ${result.message}`)
      })
      .catch((error: unknown) => {
        this.log.error(`The agent for ${taskId} failed`, (error as Error).message)
      })
      .finally(() => {
        active.running.delete(taskId)
        void this.syncNow().catch(() => {})
      })

    return {
      sessionId: '',
      started: true,
      message: `Agent started for "${task.title}". Progress appears in the session timeline.`
    }
  }

  async cancelAgent(taskId: string): Promise<void> {
    const active = this.requireActive()
    const run = active.running.get(taskId)
    if (!run) return
    run.controller.abort()
    this.log.warn(`Canceled the agent for ${taskId}`)
  }

  async sendInstruction(sessionId: string, text: string): Promise<void> {
    const active = this.requireActive()
    await active.provider.submitOperation({
      kind: 'queue_instruction',
      sessionId,
      text
    })
    // Published immediately: an instruction nobody can see is useless.
    await this.syncNow()
  }

  getSessions(): AgentSession[] {
    return this.requireActive().provider.getAgentSessions()
  }

  getState(): ProjectState {
    return this.requireActive().provider.getProjectState()
  }

  get root(): string {
    return this.requireActive().root
  }

  get developerId(): string {
    return this.requireActive().developerId
  }

  /** Tasks this machine is currently running an agent for. */
  get locallyRunning(): string[] {
    return [...(this.active?.running.keys() ?? [])]
  }
}
