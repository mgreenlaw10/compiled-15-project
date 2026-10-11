/**
 * Collaboration handlers.
 *
 * Thin adapters, like every other handler module: validate the arguments, call
 * into `CollabService`, return. No Git, no merge logic and no agent
 * orchestration lives here.
 */

import type {
  CollabSnapshot,
  CreateTaskRequest,
  IntegrationReport,
  StartAgentResult,
  WorkspaceStatus
} from '../../../shared/ipc'
import { COLLAB_CHANNELS } from '../../../shared/ipc'
import type { Task } from '../../../shared/collab'
import {
  assessIntegration,
  branchForTask,
  cloneForCollaboration,
  mergeTaskBranch,
  runValidation
} from '../../../core/collab'
import { Git } from '../../../core/git/git'
import { asString, type HandlerModule } from '../context'

export const collabHandlers: HandlerModule = (ctx) => {
  const service = ctx.collab

  /** Shared by assess / submit / integrate so they cannot disagree. */
  async function assess(taskId: string): Promise<{
    task: Task
    report: IntegrationReport
  }> {
    const state = service.getState()
    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`No task ${taskId}`)

    const graph = ctx.getGraph()
    if (!graph) {
      throw new Error(
        'The project has not been analyzed, so integration cannot check architectural compatibility.'
      )
    }

    // Other in-flight tasks, so cross-task collisions are reported.
    const others = await Promise.all(
      state.tasks
        .filter((other) => other.id !== taskId && other.status !== 'completed')
        .map(async (other) => {
          const git = new Git(service.root)
          const branch = other.branch ?? branchForTask(other.id)
          const head = await git.resolveRef(branch)
          const base = other.baseCommit ?? head
          return {
            taskId: other.id,
            moduleIds: other.moduleIds,
            changedPaths:
              head && base && head !== base
                ? await git.changedFiles(base, head)
                : [],
            graph: null
          }
        })
    )

    const assessment = await assessIntegration({
      repoRoot: service.root,
      task,
      targetBranch: state.project.integratedBranch,
      baseGraph: graph,
      others,
      logger: ctx.logger.child('collab')
    })

    return {
      task,
      report: {
        requestId: `integ_${task.id}`,
        status: assessment.status,
        conflicts: assessment.conflicts,
        validations: [],
        changedPaths: assessment.changedPaths,
        outOfScopePaths: assessment.outOfScopePaths,
        scopeSummary: assessment.scopeSummary,
        mergesCleanly: assessment.mergesCleanly,
        note: assessment.note
      }
    }
  }

  return {
    [COLLAB_CHANNELS.inspectWorkspace]: async (
      _e: unknown,
      root: unknown
    ): Promise<WorkspaceStatus> => service.inspect(asString(root, 'root')),

    [COLLAB_CHANNELS.initializeCollaboration]: async (
      _e: unknown,
      req: unknown
    ): Promise<WorkspaceStatus> => {
      const request = (req ?? {}) as {
        root?: string
        projectName?: string
        remoteUrl?: string
      }
      return service.initialize({
        root: asString(request.root, 'root'),
        projectName: asString(request.projectName, 'projectName'),
        ...(request.remoteUrl ? { remoteUrl: request.remoteUrl } : {})
      })
    },

    [COLLAB_CHANNELS.joinCollaboration]: async (
      _e: unknown,
      root: unknown
    ): Promise<WorkspaceStatus> => service.join(asString(root, 'root')),

    [COLLAB_CHANNELS.cloneProject]: async (_e: unknown, req: unknown) => {
      const request = (req ?? {}) as { url?: string; destination?: string }
      return cloneForCollaboration({
        url: asString(request.url, 'url'),
        destination: asString(request.destination, 'destination'),
        logger: ctx.logger.child('collab')
      })
    },

    [COLLAB_CHANNELS.collabConnect]: async (
      _e: unknown,
      root: unknown
    ): Promise<CollabSnapshot> => service.connect(asString(root, 'root')),

    [COLLAB_CHANNELS.collabDisconnect]: async (): Promise<void> =>
      service.disconnect(),

    [COLLAB_CHANNELS.getSnapshot]: async (): Promise<CollabSnapshot | null> =>
      service.isConnected ? service.snapshot() : null,

    [COLLAB_CHANNELS.synchronize]: async (): Promise<CollabSnapshot> =>
      service.syncNow(),

    [COLLAB_CHANNELS.createTask]: async (_e: unknown, req: unknown): Promise<Task> => {
      const request = (req ?? {}) as Partial<CreateTaskRequest>
      if (!Array.isArray(request.moduleIds) || request.moduleIds.length === 0) {
        throw new Error('A task needs at least one module')
      }
      return service.createTask({
        title: asString(request.title, 'title'),
        description: request.description ?? '',
        moduleIds: request.moduleIds,
        assignedAgent: request.assignedAgent ?? null,
        graphVersion: request.graphVersion ?? 0,
        claimModules: request.claimModules !== false
      })
    },

    [COLLAB_CHANNELS.updateTask]: async (_e: unknown, req: unknown): Promise<void> => {
      const request = (req ?? {}) as { taskId?: string; changes?: Partial<Task> }
      await service.updateTask(
        asString(request.taskId, 'taskId'),
        request.changes ?? {}
      )
    },

    [COLLAB_CHANNELS.claimModule]: async (_e: unknown, req: unknown): Promise<void> => {
      const request = (req ?? {}) as { moduleId?: string; taskId?: string }
      await service.claimModule(
        asString(request.moduleId, 'moduleId'),
        asString(request.taskId, 'taskId')
      )
    },

    [COLLAB_CHANNELS.releaseModule]: async (
      _e: unknown,
      moduleId: unknown
    ): Promise<void> => service.releaseModule(asString(moduleId, 'moduleId')),

    [COLLAB_CHANNELS.startAgent]: async (
      _e: unknown,
      req: unknown
    ): Promise<StartAgentResult> => {
      const request = (req ?? {}) as { taskId?: string }
      return service.startAgent(asString(request.taskId, 'taskId'))
    },

    [COLLAB_CHANNELS.sendInstruction]: async (
      _e: unknown,
      req: unknown
    ): Promise<void> => {
      const request = (req ?? {}) as { sessionId?: string; text?: string }
      await service.sendInstruction(
        asString(request.sessionId, 'sessionId'),
        asString(request.text, 'text')
      )
    },

    [COLLAB_CHANNELS.cancelAgent]: async (
      _e: unknown,
      taskId: unknown
    ): Promise<void> => service.cancelAgent(asString(taskId, 'taskId')),

    [COLLAB_CHANNELS.assessIntegration]: async (
      _e: unknown,
      req: unknown
    ): Promise<IntegrationReport> => {
      const request = (req ?? {}) as { taskId?: string }
      const { report } = await assess(asString(request.taskId, 'taskId'))
      return report
    },

    /**
     * Records the task as submitted for review and publishes the assessment,
     * so the other developers see the conflicts too. Merges nothing.
     */
    [COLLAB_CHANNELS.submitIntegration]: async (
      _e: unknown,
      req: unknown
    ): Promise<IntegrationReport> => {
      const request = (req ?? {}) as { taskId?: string }
      const taskId = asString(request.taskId, 'taskId')
      const { task, report } = await assess(taskId)

      await service.provider.submitOperation({
        kind: 'upsert_integration',
        request: {
          id: report.requestId,
          taskId,
          sourceBranch: task.branch ?? branchForTask(taskId),
          targetBranch: service.getState().project.integratedBranch,
          status: report.status as IntegrationReport['status'] as never,
          conflicts: report.conflicts,
          changedPaths: report.changedPaths,
          outOfScopePaths: report.outOfScopePaths,
          note: report.note
        }
      })
      await service.updateTask(taskId, {
        status: report.status === 'conflicted' ? 'conflict' : 'review'
      })
      return report
    },

    /**
     * Assesses, validates, merges and publishes. Refuses on a blocking
     * conflict rather than merging and hoping.
     */
    [COLLAB_CHANNELS.integrateTask]: async (
      _e: unknown,
      req: unknown
    ): Promise<IntegrationReport> => {
      const request = (req ?? {}) as { taskId?: string }
      const taskId = asString(request.taskId, 'taskId')
      const { task, report } = await assess(taskId)
      const state = service.getState()

      if (report.status === 'conflicted') {
        await service.updateTask(taskId, { status: 'conflict' })
        return report
      }

      const validations = await runValidation({
        allowCommands: state.project.settings.allowValidationCommands,
        cwd: service.root,
        logger: ctx.logger.child('validation')
      })
      const failed = validations.some((v) => v.status === 'failed')
      if (failed) {
        await service.updateTask(taskId, { status: 'conflict' })
        return { ...report, status: 'failed', validations }
      }

      const merged = await mergeTaskBranch({
        repoRoot: service.root,
        task,
        targetBranch: state.project.integratedBranch,
        logger: ctx.logger.child('collab')
      })

      const finalReport: IntegrationReport = {
        ...report,
        validations,
        status: merged.ok ? 'merged' : 'failed',
        note: merged.note
      }

      await service.provider.submitOperation({
        kind: 'upsert_integration',
        request: {
          id: report.requestId,
          taskId,
          status: merged.ok ? 'merged' : 'failed',
          mergeCommit: merged.mergeCommit,
          validations,
          conflicts: report.conflicts,
          note: merged.note,
          resolvedAt: new Date().toISOString()
        }
      })
      if (merged.ok) {
        await service.updateTask(taskId, {
          status: 'completed',
          closedAt: new Date().toISOString()
        })
        for (const moduleId of task.moduleIds) {
          await service.releaseModule(moduleId)
        }
        await service.provider.submitOperation({
          kind: 'record_event',
          event: {
            kind: 'integration_merged',
            message: `integrated "${task.title}"`,
            taskId,
            moduleIds: task.moduleIds
          }
        })
      }
      await service.syncNow()
      return finalReport
    },

    [COLLAB_CHANNELS.taskDiff]: async (_e: unknown, taskId: unknown) => {
      const id = asString(taskId, 'taskId')
      const state = service.getState()
      const task = state.tasks.find((t) => t.id === id)
      if (!task) throw new Error(`No task ${id}`)

      const git = new Git(service.root)
      const branch = task.branch ?? branchForTask(id)
      const head = await git.resolveRef(branch)
      if (!head) return { patch: '', changedPaths: [] }

      const base =
        (await git.mergeBase(state.project.integratedBranch, head)) ??
        task.baseCommit ??
        head
      return {
        patch: await git.diff(base, head),
        changedPaths: await git.changedFiles(base, head)
      }
    },

    [COLLAB_CHANNELS.getTasks]: async (): Promise<Task[]> =>
      service.isConnected ? service.getState().tasks : [],

    [COLLAB_CHANNELS.getSessions]: async () =>
      service.isConnected ? service.getSessions() : [],

    [COLLAB_CHANNELS.getReservations]: async () =>
      service.isConnected ? service.getState().reservations : []
  }
}
