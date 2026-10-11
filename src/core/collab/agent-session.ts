/**
 * Running an agent on a task, in a shared session.
 *
 * The session belongs to the project and the task, not to whoever started it.
 * Any developer can watch it and queue instructions; exactly one machine — the
 * *execution host* — actually runs the agent, because two processes editing one
 * worktree would corrupt it.
 *
 * What goes to the coordination branch is checkpoints, never tokens:
 * "started", "read these files", "wrote login.ts", "tests failed", "committed
 * abc123". Streaming every generated token through Git would produce an
 * unreadable history and an enormous branch, and nobody watching needs it.
 *
 * Instructions from collaborators are picked up between turns — a *safe
 * checkpoint* — rather than mid-turn, so an instruction can never arrive
 * half-way through a file write.
 *
 * Known limitation, stated plainly because it is architectural: if the host
 * goes offline mid-task, nobody else can resume that agent. The worktree lives
 * on that machine. The session is marked offline, pending instructions are
 * kept, and the work on the branch is whatever was last committed.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ArchitectureGraph } from '../../shared/types/architecture'
import type { GraphOperation } from '../../shared/types/operations'
import type {
  ActivityEntry,
  ActivityKind,
  AgentSession,
  ProjectState,
  Task
} from '../../shared/collab'
import type { AiConfig } from '../../shared/ai'
import { normalizeRel } from '../../shared/util/paths'
import type { ChannelLogger } from '../logger'
import { createAiClient, isConfigured } from '../ai/client'
import { runAgent, type AgentOutcome } from '../ai/agent'
import { VirtualWorkspace } from '../transform/workspace'
import { Git } from '../git/git'
import { buildAgentBrief } from './agent-context'
import type { CollaborationProvider } from './provider'
import { buildScope } from './scope'
import { prepareTaskWorkspace, type TaskWorkspace } from './tasks'

/** How often the host republishes its heartbeat while working. */
const HEARTBEAT_INTERVAL_MS = 45_000

export interface RunTaskAgentOptions {
  repoRoot: string
  task: Task
  graph: ArchitectureGraph
  config: AiConfig | null
  provider: CollaborationProvider
  /** Stable per-install id. Identifies the execution host. */
  hostId: string
  developerId: string
  logger: ChannelLogger
  signal?: AbortSignal
  /** Injectable for tests, so the orchestration runs without a network call. */
  runner?: typeof runAgent
}

export interface RunTaskAgentResult {
  sessionId: string
  outcome: AgentOutcome | null
  commit: string | null
  changedPaths: string[]
  status: AgentSession['status']
  message: string
}

let activityCounter = 0
function activityId(): string {
  activityCounter += 1
  return `act_${Date.now().toString(36)}_${activityCounter.toString(36)}`
}

function entry(
  kind: ActivityKind,
  message: string,
  extra: { detail?: string; paths?: string[] } = {}
): ActivityEntry {
  return {
    id: activityId(),
    at: new Date().toISOString(),
    kind,
    message,
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.paths ? { paths: extra.paths } : {})
  }
}

/**
 * Claims the session for this host, or refuses.
 *
 * The check is advisory — Git cannot give us a real lock — but it is honest:
 * it reads the latest shared state before deciding, and it refuses rather than
 * racing when another host is plainly alive.
 */
export async function claimSession(options: {
  provider: CollaborationProvider
  task: Task
  hostId: string
  developerId: string
  branch: string
}): Promise<{ sessionId: string; claimed: boolean; reason: string }> {
  await options.provider.synchronize()
  const state = options.provider.getProjectState()
  const existing = state.sessions.find((s) => s.taskId === options.task.id)

  if (existing?.host && existing.host.hostId !== options.hostId) {
    const last = Date.parse(existing.host.lastHeartbeatAt)
    const alive =
      Number.isFinite(last) && Date.now() - last < 3 * HEARTBEAT_INTERVAL_MS
    if (alive && existing.status === 'running') {
      return {
        sessionId: existing.id,
        claimed: false,
        reason: `This task is already being run by ${existing.host.developerId}. Only one machine may drive a session at a time.`
      }
    }
  }

  const sessionId = existing?.id ?? `session_${randomUUID().slice(0, 8)}`
  await options.provider.submitOperation({
    kind: 'upsert_session',
    session: {
      id: sessionId,
      taskId: options.task.id,
      branch: options.branch,
      status: 'running',
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      host: {
        hostId: options.hostId,
        developerId: options.developerId,
        lastHeartbeatAt: new Date().toISOString()
      }
    }
  })
  return { sessionId, claimed: true, reason: '' }
}

/**
 * Loads a worktree's source into a `VirtualWorkspace`.
 *
 * The agent's tools are written against the workspace abstraction the
 * single-player transformer already uses, so reusing it here means the tools,
 * their validation and their import-rewriting all work unchanged. Results are
 * flushed back to the worktree before anything is committed or validated.
 */
async function loadWorkspace(
  worktreePath: string,
  files: readonly string[]
): Promise<VirtualWorkspace> {
  const entries: [string, string][] = []
  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(worktreePath, file), 'utf8')
      entries.push([normalizeRel(file), content])
    } catch {
      // A file in the graph that is not on this branch yet; skip it.
    }
  }
  return new VirtualWorkspace(worktreePath, entries)
}

/** Writes the agent's edits into the worktree. */
async function flushWorkspace(
  workspace: VirtualWorkspace,
  worktreePath: string
): Promise<string[]> {
  const written: string[] = []

  for (const change of workspace.changes()) {
    const target = path.join(worktreePath, change.path)
    if (change.kind === 'delete') {
      await fs.rm(target, { force: true }).catch(() => {})
      written.push(change.path)
      continue
    }

    const content = workspace.read(change.path)
    if (content === null) continue
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    written.push(change.path)

    // A move leaves the old path behind unless it is removed explicitly.
    if (change.kind === 'rename' && change.previousPath) {
      await fs
        .rm(path.join(worktreePath, change.previousPath), { force: true })
        .catch(() => {})
      written.push(change.previousPath)
    }
  }
  return [...new Set(written)]
}

/**
 * The whole run: claim, brief, execute, flush, commit, publish.
 *
 * Progress is published as it happens rather than at the end, so a collaborator
 * watching the session sees the work unfold instead of a long silence followed
 * by a result.
 */
export async function runTaskAgent(
  options: RunTaskAgentOptions
): Promise<RunTaskAgentResult> {
  const log = options.logger
  const { task, provider } = options

  if (!isConfigured(options.config) || !options.config) {
    return {
      sessionId: '',
      outcome: null,
      commit: null,
      changedPaths: [],
      status: 'failed',
      message:
        'No model provider API key is configured, so no agent can be started. Add one in Settings.'
    }
  }

  // --- the worktree --------------------------------------------------------
  const repo = new Git(options.repoRoot)
  const baseCommit =
    task.baseCommit ?? (await repo.resolveRef('HEAD')) ?? (await repo.headCommit())
  if (!baseCommit) {
    return {
      sessionId: '',
      outcome: null,
      commit: null,
      changedPaths: [],
      status: 'failed',
      message: 'The repository has no commits to branch from.'
    }
  }

  const workspace: TaskWorkspace = await prepareTaskWorkspace({
    repoRoot: options.repoRoot,
    taskId: task.id,
    baseCommit,
    logger: log
  })

  // --- the session ---------------------------------------------------------
  const claim = await claimSession({
    provider,
    task,
    hostId: options.hostId,
    developerId: options.developerId,
    branch: workspace.branch
  })
  if (!claim.claimed) {
    log.warn(claim.reason)
    return {
      sessionId: claim.sessionId,
      outcome: null,
      commit: null,
      changedPaths: [],
      status: 'running',
      message: claim.reason
    }
  }
  const sessionId = claim.sessionId

  const publish = async (entries: ActivityEntry[]): Promise<void> => {
    await provider.submitOperation({ kind: 'append_activity', sessionId, entries })
  }

  const heartbeat = setInterval(() => {
    void provider.submitOperation({
      kind: 'upsert_session',
      session: {
        id: sessionId,
        taskId: task.id,
        host: {
          hostId: options.hostId,
          developerId: options.developerId,
          lastHeartbeatAt: new Date().toISOString()
        }
      }
    })
    // Keep the module reservation alive while real work is happening, so a
    // long task does not lose its claim to a lease expiry.
    for (const moduleId of task.moduleIds) {
      void provider.submitOperation({ kind: 'renew_reservation', moduleId })
    }
  }, HEARTBEAT_INTERVAL_MS)

  try {
    await provider.submitOperation({
      kind: 'update_task',
      taskId: task.id,
      changes: { status: 'planning', branch: workspace.branch, baseCommit }
    })
    await publish([
      entry('started', `Agent started on ${workspace.branch}`, {
        detail: `forked from ${baseCommit.slice(0, 8)}`
      })
    ])
    await provider.synchronize()

    // --- the brief ---------------------------------------------------------
    const scope = buildScope(options.graph, task.moduleIds)
    const brief = buildAgentBrief({
      graph: options.graph,
      task,
      collabState: provider.getProjectState(),
      allowedPaths: scope.map((s) => ({
        moduleId: s.moduleId,
        directory: s.directory,
        files: [...s.files]
      })),
      baseCommit
    })

    // Instructions a collaborator queued before the agent started count as
    // part of the brief: they were sent in time to matter.
    const pending = pendingInstructions(provider.getProjectState(), sessionId)
    const briefWithInstructions =
      pending.length === 0
        ? brief
        : `${brief}\n\n## Additional instructions from the team\n\n${pending
            .map((i) => `  - ${i.text} (from ${i.fromDeveloper})`)
            .join('\n')}`

    for (const instruction of pending) {
      await provider.submitOperation({
        kind: 'resolve_instruction',
        sessionId,
        instructionId: instruction.id,
        status: 'accepted',
        note: 'included in the task brief'
      })
    }

    // --- run ---------------------------------------------------------------
    const vfs = await loadWorkspace(
      workspace.path,
      options.graph.modules.flatMap((m) => m.files)
    )
    const client = createAiClient(options.config)

    await provider.submitOperation({
      kind: 'update_task',
      taskId: task.id,
      changes: { status: 'coding' }
    })

    // The agent tools expect an operation to attribute changes to; a
    // collaborative task is expressed as a scaffold of its primary module.
    const pseudoOperation: GraphOperation = {
      type: 'scaffold_module',
      moduleId: task.moduleIds[0] ?? '',
      id: `op_${task.id}`,
      actor: options.developerId,
      issuedAt: new Date().toISOString(),
      baseVersion: options.graph.version
    } as GraphOperation

    const run = options.runner ?? runAgent
    const outcome = await run({
      client,
      operation: pseudoOperation,
      task: briefWithInstructions,
      toolContext: {
        workspace: vfs,
        graph: options.graph,
        nextGraph: options.graph,
        log
      },
      log,
      ...(options.signal ? { signal: options.signal } : {})
    })

    // --- flush, commit -----------------------------------------------------
    const written = await flushWorkspace(vfs, workspace.path)
    if (written.length > 0) {
      await publish([
        entry('files_changed', `Changed ${written.length} file(s)`, { paths: written })
      ])
    }

    await provider.submitOperation({
      kind: 'update_task',
      taskId: task.id,
      changes: { status: 'testing' }
    })

    const commit = await workspace.git.commitAll(
      `${task.title}\n\nTask: ${task.id}\nAgent: ${task.assignedAgent ?? 'agent'}`
    )
    if (commit) {
      await publish([
        entry('commit', `Committed ${commit.slice(0, 8)}`, { paths: written })
      ])
      await provider.submitOperation({
        kind: 'upsert_session',
        session: {
          id: sessionId,
          taskId: task.id,
          commits: [
            ...(provider
              .getProjectState()
              .sessions.find((s) => s.id === sessionId)?.commits ?? []),
            commit
          ]
        }
      })
    }

    // --- report ------------------------------------------------------------
    const report = outcome.report
    const succeeded = report?.status === 'applied' && outcome.stoppedBecause === null

    await publish([
      entry(
        succeeded ? 'finished' : 'error',
        report?.summary ?? outcome.stoppedBecause ?? 'The agent stopped without reporting.',
        {
          detail: [
            `${outcome.turns} turn(s)`,
            `${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out`,
            ...(report?.warnings ?? [])
          ].join(' · ')
        }
      )
    ])

    await provider.submitOperation({
      kind: 'upsert_session',
      session: {
        id: sessionId,
        taskId: task.id,
        status: succeeded ? 'awaiting_review' : 'failed',
        finishedAt: new Date().toISOString()
      }
    })
    await provider.submitOperation({
      kind: 'update_task',
      taskId: task.id,
      changes: { status: succeeded ? 'review' : 'open' }
    })
    await provider.synchronize()

    return {
      sessionId,
      outcome,
      commit,
      changedPaths: written,
      status: succeeded ? 'awaiting_review' : 'failed',
      message:
        report?.summary ??
        outcome.stoppedBecause ??
        'The agent finished without a report.'
    }
  } catch (error) {
    const message = (error as Error).message
    log.error('The agent run failed', message)
    await publish([entry('error', 'The agent run failed', { detail: message })]).catch(
      () => {}
    )
    await provider
      .submitOperation({
        kind: 'upsert_session',
        session: {
          id: sessionId,
          taskId: task.id,
          status: 'failed',
          finishedAt: new Date().toISOString()
        }
      })
      .catch(() => {})
    return {
      sessionId,
      outcome: null,
      commit: null,
      changedPaths: [],
      status: 'failed',
      message
    }
  } finally {
    clearInterval(heartbeat)
    await provider.synchronize().catch(() => {})
  }
}

/** Instructions nobody has processed yet. */
export function pendingInstructions(
  state: ProjectState,
  sessionId: string
): { id: string; text: string; fromDeveloper: string }[] {
  const session = state.sessions.find((s) => s.id === sessionId)
  return (session?.instructions ?? [])
    .filter((instruction) => instruction.status === 'pending')
    .map((instruction) => ({
      id: instruction.id,
      text: instruction.text,
      fromDeveloper: instruction.fromDeveloper
    }))
}

/**
 * Marks a session offline.
 *
 * Called when the host shuts down cleanly. A host that dies without this is
 * detected by its heartbeat going stale, which is why the UI treats a silent
 * "running" session as unknown rather than live.
 */
export async function markSessionOffline(options: {
  provider: CollaborationProvider
  sessionId: string
  taskId: string
}): Promise<void> {
  await options.provider.submitOperation({
    kind: 'upsert_session',
    session: { id: options.sessionId, taskId: options.taskId, status: 'offline' }
  })
}
