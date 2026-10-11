/**
 * Collaboration over Git, and nothing else.
 *
 * The whole synchronization strategy, in one place:
 *
 *   1. Apply the user's operation to local state immediately and append it to a
 *      durable queue. The UI never waits for the network, and a failed push
 *      cannot lose an edit.
 *   2. On `synchronize`: fetch the coordination branch, merge the remote state
 *      into ours *by value* (`mergeProjectState`), replay queued operations on
 *      top, commit the result onto `collab-state`, and push **without force**.
 *   3. If the push is rejected because someone pushed first, re-fetch, re-merge
 *      and retry. Because the merge is convergent, retrying is safe and
 *      terminating — we never need to overwrite their work to publish ours.
 *
 * The coordination branch is read and written without ever being checked out,
 * so none of this can disturb the user's working tree or their uncommitted
 * changes.
 *
 * What this cannot do, and does not pretend to: it is not real-time, a
 * reservation is advisory rather than a lock, and two clones can briefly
 * disagree. Every one of those shows in the UI as staleness rather than being
 * papered over.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ModuleId } from '../../shared/types/architecture'
import {
  DEFAULT_COLLAB_SETTINGS,
  COLLAB_SCHEMA_VERSION,
  emptyProjectState,
  initialRevision,
  isReservationExpired,
  mergeProjectState,
  touch,

  type AgentSession,
  type CollabEvent,
  type CollabProject,
  type Developer,
  type Instruction,
  type IntegrationRequest,
  type ModuleReservation,
  type ProjectState,
  type Task
} from '../../shared/collab'
import type { ChannelLogger } from '../logger'
import { Git, GitError } from '../git/git'
import { COLLAB_BRANCH, COLLAB_FILES, deserializeState, serializeState } from './layout'
import type {
  CollaborationOperation,
  CollaborationProvider,
  Freshness,
  SyncReport
} from './provider'

/** How many times to re-merge and retry a rejected push before giving up. */
const MAX_PUSH_ATTEMPTS = 5

/** After this long without a successful sync, the view is called stale. */
const STALENESS_WINDOW_MS = 90_000

export interface GitProviderOptions {
  /** Repository root. */
  repoRoot: string
  /** This install's developer id. Stable across restarts. */
  developerId: string
  displayName: string
  remote?: string
  logger: ChannelLogger
  /** Where the durable operation queue is cached. Local, never committed. */
  queuePath?: string
  now?: () => number
}

let sequence = 0
function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`
}

export class GitCollaborationProvider implements CollaborationProvider {
  private readonly git: Git
  private readonly remote: string
  private readonly log: ChannelLogger
  private readonly now: () => number

  /**
   * The last state we know the remote agreed with: whatever was merged or
   * published, with none of our unpublished edits folded in.
   */
  private baseState: ProjectState
  /**
   * `baseState` plus every queued operation. Derived, never mutated directly.
   * Keeping the two apart is what makes replay idempotent: a queued operation
   * is applied exactly once per rebuild, however many times we re-merge.
   */
  private state: ProjectState
  /** Operations applied locally but not yet confirmed on the remote. */
  private queue: CollaborationOperation[] = []
  private lastSyncAt: string | null = null
  private lastKnownOnline = false
  private stateCommit: string | null = null
  private connected = false
  /** Serializes synchronize() so two timers cannot interleave Git writes. */
  private syncing: Promise<SyncReport> | null = null

  constructor(private readonly options: GitProviderOptions) {
    this.git = new Git(options.repoRoot)
    this.remote = options.remote ?? 'origin'
    this.log = options.logger
    this.now = options.now ?? (() => Date.now())
    this.baseState = emptyProjectState(placeholderProject(options))
    this.state = this.baseState
  }

  private get queueFile(): string {
    return (
      this.options.queuePath ??
      path.join(this.options.repoRoot, '.cartograph', 'collab-queue.json')
    )
  }

  // --- lifecycle -----------------------------------------------------------

  async connect(): Promise<void> {
    await this.loadQueue()
    const local = await this.readStateFromBranch(`refs/heads/${COLLAB_BRANCH}`)
    if (local) {
      this.baseState = local.state
      this.stateCommit = local.commit
      this.log.info(
        `Loaded collaboration state: ${this.state.tasks.length} task(s), ${this.state.developers.length} developer(s)`
      )
    }
    // Rebuilding from the queue means a crash between "applied locally" and
    // "published" still leaves the UI showing the user's own edits.
    this.rebuild()
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    await this.saveQueue()
  }

  getProjectState(): ProjectState {
    return this.state
  }

  getFreshness(): Freshness {
    const last = this.lastSyncAt ? Date.parse(this.lastSyncAt) : null
    return {
      lastSyncAt: this.lastSyncAt,
      stale:
        last === null || !Number.isFinite(last)
          ? true
          : this.now() - last > STALENESS_WINDOW_MS,
      queued: this.queue.length,
      online: this.lastKnownOnline
    }
  }

  getTasks(): Task[] {
    return this.state.tasks
  }

  getAgentSessions(): AgentSession[] {
    return this.state.sessions
  }

  getReservations(): ModuleReservation[] {
    return this.state.reservations
  }

  // --- submitting ----------------------------------------------------------

  async submitOperation(operation: CollaborationOperation): Promise<void> {
    if (!this.connected) throw new Error('The collaboration provider is not connected')
    this.queue.push(operation)
    this.rebuild()
    await this.saveQueue()
  }

  // --- synchronization -----------------------------------------------------

  async synchronize(): Promise<SyncReport> {
    // One at a time. Concurrent passes would both build commits on the same
    // ref and one would be silently discarded.
    if (this.syncing) return this.syncing
    this.syncing = this.runSynchronize().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async runSynchronize(): Promise<SyncReport> {
    const report: SyncReport = {
      online: false,
      stateCommit: this.stateCommit,
      published: 0,
      queued: this.queue.length,
      retries: 0,
      contested: [],
      expiredReservations: [],
      error: null,
      at: new Date(this.now()).toISOString()
    }

    const hasRemote = await this.git.hasRemote(this.remote)

    if (hasRemote) {
      try {
        // `+refs/heads/x:refs/remotes/origin/x` so a diverged coordination
        // branch still updates the tracking ref; this touches no local branch.
        await this.git.fetch(this.remote, [
          `+refs/heads/${COLLAB_BRANCH}:refs/remotes/${this.remote}/${COLLAB_BRANCH}`
        ])
        report.online = true
        this.lastKnownOnline = true
      } catch (error) {
        // Offline is a normal state, not a failure: keep serving cached state.
        this.lastKnownOnline = false
        report.error = `Could not reach ${this.remote}: ${(error as Error).message}`
        this.log.debug('Collaboration fetch failed; continuing from cache', report.error)
      }
    }

    // Merge whatever the remote has into our view.
    if (report.online) {
      const remoteState = await this.readStateFromBranch(
        `refs/remotes/${this.remote}/${COLLAB_BRANCH}`
      )
      if (remoteState) {
        // What our own queued edits are about to land on top of. Detected
        // before merging, because afterwards the two are indistinguishable.
        const overlap = contestedWithQueue(
          this.baseState,
          remoteState.state,
          this.queue
        )

        // Merge remote into the *base*, not into our derived view: our own
        // queued edits are re-applied afterwards, and folding them in here
        // would make them look like someone else's published work.
        const merged = mergeProjectState(this.baseState, remoteState.state)
        this.baseState = merged.state
        report.contested = [...merged.contested, ...overlap]
        for (const item of merged.contested) {
          this.log.debug(
            `Reconciled a concurrent edit to ${item.kind} ${item.id}; both sides were kept where possible`
          )
        }
      }
    }

    // Re-derive, so our edits sit on top of theirs.
    this.rebuild()

    const expired = this.dropExpiredReservations()
    report.expiredReservations = expired

    const needsPublish = this.queue.length > 0 || expired.length > 0

    if (needsPublish && report.online) {
      try {
        const published = await this.publish()
        report.published = this.queue.length
        report.retries = published.attempts - 1
        report.stateCommit = published.commit
        this.stateCommit = published.commit
        this.queue = []
        await this.saveQueue()
        report.queued = 0
      } catch (error) {
        // The queue is deliberately kept: the user's edits are not lost, and
        // the next pass will try again.
        report.error = (error as Error).message
        report.queued = this.queue.length
        this.log.warn('Could not publish collaboration state; it stays queued', report.error)
      }
    } else if (needsPublish) {
      // Offline: commit locally so a restart does not lose the work, but do
      // not claim it was shared.
      await this.commitStateLocally()
      report.stateCommit = this.stateCommit
      report.queued = this.queue.length
    } else if (report.online) {
      // Nothing of ours to publish; just record what we now hold.
      const head = await this.git.resolveRef(`refs/heads/${COLLAB_BRANCH}`)
      report.stateCommit = head
      this.stateCommit = head
    }

    if (report.online && report.error === null) {
      this.lastSyncAt = report.at
    }
    return report
  }

  /**
   * Commits the merged state onto `collab-state` and pushes it.
   *
   * On rejection: fetch, merge the newly published state, replay our queue,
   * rebuild, retry. Never a force push — the loop converges because the merge
   * is order-independent, so their state plus ours is the same value whichever
   * side got there first.
   */
  private async publish(): Promise<{ commit: string; attempts: number }> {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
      const commit = await this.commitStateLocally()

      try {
        await this.git.push(this.remote, `refs/heads/${COLLAB_BRANCH}:refs/heads/${COLLAB_BRANCH}`)
        // What we just published is now the agreed base; the queue that
        // produced it is about to be cleared by the caller.
        this.baseState = this.state
        return { commit, attempts: attempt }
      } catch (error) {
        lastError = error as Error
        if (!(error instanceof GitError) || !error.isNonFastForward) throw error

        this.log.debug(
          `Coordination branch moved on; re-merging and retrying (${attempt}/${MAX_PUSH_ATTEMPTS})`
        )
        await this.git.fetch(this.remote, [
          `+refs/heads/${COLLAB_BRANCH}:refs/remotes/${this.remote}/${COLLAB_BRANCH}`
        ])
        const remoteState = await this.readStateFromBranch(
          `refs/remotes/${this.remote}/${COLLAB_BRANCH}`
        )
        if (remoteState) {
          this.baseState = mergeProjectState(this.baseState, remoteState.state).state
          // Point our branch at theirs so the next commit is a fast-forward
          // child of what they published, rather than a sibling.
          this.stateCommit = remoteState.commit
          await this.git.updateRef(`refs/heads/${COLLAB_BRANCH}`, remoteState.commit)
        }
        this.rebuild()
      }
    }

    throw new Error(
      `Could not publish collaboration state after ${MAX_PUSH_ATTEMPTS} attempts: ${
        lastError?.message ?? 'unknown error'
      }`
    )
  }

  /** Writes current state onto the coordination branch, without checking it out. */
  private async commitStateLocally(): Promise<string> {
    const parent = await this.git.resolveRef(`refs/heads/${COLLAB_BRANCH}`)
    const commit = await this.git.writeBranchFiles({
      branch: COLLAB_BRANCH,
      files: serializeState(this.state),
      message: `collab: update coordination state (${this.options.displayName})`,
      parent,
      preserveExisting: true
    })
    this.stateCommit = commit
    return commit
  }

  private async readStateFromBranch(
    ref: string
  ): Promise<{ state: ProjectState; commit: string } | null> {
    const commit = await this.git.resolveRef(ref)
    if (!commit) return null

    const read = async (file: string): Promise<string | null> =>
      this.git.readFileAtRef(commit, file)

    const state = deserializeState(
      {
        project: await read(COLLAB_FILES.project),
        developers: await read(COLLAB_FILES.developers),
        tasks: await read(COLLAB_FILES.tasks),
        reservations: await read(COLLAB_FILES.reservations),
        sessions: await read(COLLAB_FILES.sessions),
        operations: await read(COLLAB_FILES.operations),
        integrations: await read(COLLAB_FILES.integrations),
        events: await read(COLLAB_FILES.events)
      },
      placeholderProject(this.options)
    )
    return { state, commit }
  }

  // --- the operation reducer ----------------------------------------------

  /**
   * Recomputes the visible state as `baseState` + the queue.
   *
   * Always a fresh fold from the base, never an increment on top of the last
   * result. That is what keeps a second merge from applying a queued edit
   * twice — which would inflate revisions until no concurrent edit ever looked
   * contested, and would duplicate every queued instruction.
   */
  private rebuild(): void {
    let next = this.baseState
    for (const operation of this.queue) next = this.apply(next, operation)
    this.state = next
  }

  /**
   * Applies one operation. Pure in spirit: same state plus same operation gives
   * the same result, which is what makes replaying the queue after a re-merge
   * safe to do repeatedly.
   */
  private apply(state: ProjectState, op: CollaborationOperation): ProjectState {
    const me = this.options.developerId
    const nowDate = new Date(this.now())
    const nowIso = nowDate.toISOString()
    const rev = (): ReturnType<typeof initialRevision> =>
      initialRevision(me, nowDate)

    switch (op.kind) {
      case 'upsert_developer': {
        const existing = state.developers.find((d) => d.id === op.developer.id)
        const developer: Developer = existing
          ? touch({ ...existing, ...op.developer }, me, nowDate)
          : { ...op.developer, ...rev() }
        return {
          ...state,
          developers: upsert(state.developers, developer, (d) => d.id)
        }
      }

      case 'create_task': {
        const id = op.task.id ?? nextId('task')
        if (state.tasks.some((t) => t.id === id)) return state
        const task: Task = {
          id,
          title: op.task.title,
          description: op.task.description,
          moduleIds: [...op.task.moduleIds],
          assignedDeveloper: op.task.assignedDeveloper ?? me,
          assignedAgent: op.task.assignedAgent ?? null,
          status: op.task.status ?? 'open',
          branch: null,
          baseCommit: op.task.baseCommit ?? null,
          graphVersion: op.task.graphVersion,
          createdAt: nowIso,
          createdBy: me,
          closedAt: null,
          ...rev()
        }
        return {
          ...state,
          tasks: [...state.tasks, task],
          events: appendEvent(state.events, {
            id: nextId('ev'),
            at: nowIso,
            kind: 'task_created',
            actor: me,
            message: `created task "${task.title}"`,
            taskId: task.id,
            moduleIds: task.moduleIds
          })
        }
      }

      case 'update_task': {
        const existing = state.tasks.find((t) => t.id === op.taskId)
        if (!existing) return state
        const updated = touch({ ...existing, ...op.changes }, me, nowDate)
        const events =
          op.changes.status && op.changes.status !== existing.status
            ? appendEvent(state.events, {
                id: nextId('ev'),
                at: nowIso,
                kind: 'task_status_changed',
                actor: me,
                message: `task "${existing.title}" is now ${op.changes.status}`,
                taskId: existing.id,
                moduleIds: existing.moduleIds
              })
            : state.events
        return {
          ...state,
          tasks: upsert(state.tasks, updated, (t) => t.id),
          events
        }
      }

      case 'claim_module': {
        const lease =
          (op.leaseSeconds ?? state.project.settings.reservationLeaseSeconds) * 1000
        const existing = state.reservations.find((r) => r.moduleId === op.moduleId)

        // A live reservation held by someone else for a different task is not
        // overwritten here. Taking over is an explicit, separate action.
        if (
          existing &&
          !isReservationExpired(existing, this.now()) &&
          existing.taskId !== op.taskId &&
          existing.owner !== me
        ) {
          return state
        }

        const base = {
          moduleId: op.moduleId,
          taskId: op.taskId,
          owner: me,
          acquiredAt: existing?.acquiredAt ?? nowIso,
          expiresAt: new Date(this.now() + lease).toISOString()
        }
        const reservation: ModuleReservation = existing
          ? touch({ ...existing, ...base }, me, nowDate)
          : { ...base, ...rev() }

        return {
          ...state,
          reservations: upsert(state.reservations, reservation, (r) => r.moduleId),
          events: appendEvent(state.events, {
            id: nextId('ev'),
            at: nowIso,
            kind: 'module_reserved',
            actor: me,
            message: `reserved ${op.moduleId}`,
            taskId: op.taskId,
            moduleIds: [op.moduleId]
          })
        }
      }

      case 'release_module': {
        const existing = state.reservations.find((r) => r.moduleId === op.moduleId)
        if (!existing) return state
        // Expiring rather than deleting: a removal would be invisible to a
        // clone that still had the record and would simply be re-added.
        const released = touch(
          { ...existing, expiresAt: new Date(this.now() - 1000).toISOString() },
          me,
          nowDate
        )
        return {
          ...state,
          reservations: upsert(state.reservations, released, (r) => r.moduleId),
          events: appendEvent(state.events, {
            id: nextId('ev'),
            at: nowIso,
            kind: 'module_released',
            actor: me,
            message: `released ${op.moduleId}`,
            taskId: existing.taskId,
            moduleIds: [op.moduleId]
          })
        }
      }

      case 'renew_reservation': {
        const existing = state.reservations.find((r) => r.moduleId === op.moduleId)
        if (!existing || existing.owner !== me) return state
        const lease =
          (op.leaseSeconds ?? state.project.settings.reservationLeaseSeconds) * 1000
        return {
          ...state,
          reservations: upsert(
            state.reservations,
            touch(
              { ...existing, expiresAt: new Date(this.now() + lease).toISOString() },
              me,
              nowDate
            ),
            (r) => r.moduleId
          )
        }
      }

      case 'upsert_session': {
        const existing = state.sessions.find((s) => s.id === op.session.id)
        const session: AgentSession = existing
          ? touch({ ...existing, ...op.session }, me, nowDate)
          : {
              id: op.session.id,
              taskId: op.session.taskId,
              host: op.session.host ?? null,
              status: op.session.status ?? 'idle',
              branch: op.session.branch ?? null,
              activity: op.session.activity ?? [],
              instructions: op.session.instructions ?? [],
              commits: op.session.commits ?? [],
              startedAt: op.session.startedAt ?? null,
              finishedAt: op.session.finishedAt ?? null,
              ...rev()
            }
        return { ...state, sessions: upsert(state.sessions, session, (s) => s.id) }
      }

      case 'append_activity': {
        const existing = state.sessions.find((s) => s.id === op.sessionId)
        if (!existing) return state
        const known = new Set(existing.activity.map((a) => a.id))
        const added = op.entries.filter((entry) => !known.has(entry.id))
        if (added.length === 0) return state
        return {
          ...state,
          sessions: upsert(
            state.sessions,
            touch(
              { ...existing, activity: [...existing.activity, ...added] },
              me,
              nowDate
            ),
            (s) => s.id
          )
        }
      }

      case 'queue_instruction': {
        const existing = state.sessions.find((s) => s.id === op.sessionId)
        if (!existing) return state
        const instruction: Instruction = {
          id: nextId('ins'),
          at: nowIso,
          fromDeveloper: me,
          text: op.text,
          status: 'pending'
        }
        return {
          ...state,
          sessions: upsert(
            state.sessions,
            touch(
              { ...existing, instructions: [...existing.instructions, instruction] },
              me,
              nowDate
            ),
            (s) => s.id
          ),
          events: appendEvent(state.events, {
            id: nextId('ev'),
            at: nowIso,
            kind: 'instruction_sent',
            actor: me,
            message: `sent an instruction to session ${op.sessionId}`,
            taskId: existing.taskId
          })
        }
      }

      case 'resolve_instruction': {
        const existing = state.sessions.find((s) => s.id === op.sessionId)
        if (!existing) return state
        return {
          ...state,
          sessions: upsert(
            state.sessions,
            touch(
              {
                ...existing,
                instructions: existing.instructions.map((instruction) =>
                  instruction.id === op.instructionId
                    ? {
                        ...instruction,
                        status: op.status,
                        ...(op.note ? { note: op.note } : {})
                      }
                    : instruction
                )
              },
              me,
              nowDate
            ),
            (s) => s.id
          )
        }
      }

      case 'upsert_integration': {
        const existing = state.integrations.find((i) => i.id === op.request.id)
        const request: IntegrationRequest = existing
          ? touch({ ...existing, ...op.request }, me, nowDate)
          : {
              id: op.request.id,
              taskId: op.request.taskId,
              sourceBranch: op.request.sourceBranch ?? '',
              targetBranch: op.request.targetBranch ?? '',
              sourceCommit: op.request.sourceCommit ?? '',
              targetCommit: op.request.targetCommit ?? '',
              status: op.request.status ?? 'queued',
              conflicts: op.request.conflicts ?? [],
              validations: op.request.validations ?? [],
              changedPaths: op.request.changedPaths ?? [],
              outOfScopePaths: op.request.outOfScopePaths ?? [],
              mergeCommit: op.request.mergeCommit ?? null,
              submittedAt: op.request.submittedAt ?? nowIso,
              submittedBy: op.request.submittedBy ?? me,
              resolvedAt: op.request.resolvedAt ?? null,
              note: op.request.note ?? null,
              ...rev()
            }
        return {
          ...state,
          integrations: upsert(state.integrations, request, (i) => i.id)
        }
      }

      case 'record_event':
        return {
          ...state,
          events: appendEvent(state.events, {
            ...op.event,
            id: nextId('ev'),
            at: nowIso,
            actor: me
          })
        }

      default:
        return state
    }
  }

  /** Drops leases that have run out, recording it on the timeline. */
  private dropExpiredReservations(): ModuleId[] {
    const now = this.now()
    const expired = this.state.reservations.filter(
      (r) => isReservationExpired(r, now) && r.owner === this.options.developerId
    )
    if (expired.length === 0) return []

    // Only reported for our own reservations: another developer's expiry is
    // theirs to publish, and both clones announcing it would duplicate events.
    let events = this.state.events
    for (const reservation of expired) {
      events = appendEvent(events, {
        id: nextId('ev'),
        at: new Date(now).toISOString(),
        kind: 'reservation_expired',
        actor: this.options.developerId,
        message: `the reservation on ${reservation.moduleId} expired`,
        taskId: reservation.taskId,
        moduleIds: [reservation.moduleId]
      })
    }
    this.baseState = { ...this.baseState, events }
    this.rebuild()
    return expired.map((r) => r.moduleId)
  }

  // --- the durable queue ---------------------------------------------------

  private async loadQueue(): Promise<void> {
    try {
      const raw = await fs.readFile(this.queueFile, 'utf8')
      const parsed = JSON.parse(raw) as { operations?: CollaborationOperation[] }
      this.queue = parsed.operations ?? []
      if (this.queue.length > 0) {
        this.log.info(
          `Replaying ${this.queue.length} collaboration change(s) that had not reached the remote`
        )
      }
    } catch {
      this.queue = []
    }
  }

  private async saveQueue(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.queueFile), { recursive: true })
      await fs.writeFile(
        this.queueFile,
        `${JSON.stringify({ operations: this.queue }, null, 2)}\n`,
        'utf8'
      )
    } catch (error) {
      // Losing the queue file is survivable; losing the app is not.
      this.log.debug('Could not persist the collaboration queue', (error as Error).message)
    }
  }
}

// --- helpers ---------------------------------------------------------------

/**
 * Entities the remote changed that we also have an unpublished edit for.
 *
 * This is what "contested" honestly means once local edits are kept in a queue
 * rather than folded into the base: somebody else published a change to a
 * record we are about to modify, so our edit will be applied on top of theirs
 * rather than on top of what we were looking at when we made it. Nothing is
 * lost, but the user should be told — silently rebasing an edit onto different
 * content is how people end up surprised by their own changes.
 */
function contestedWithQueue(
  base: ProjectState,
  remote: ProjectState,
  queue: readonly CollaborationOperation[]
): { kind: string; id: string }[] {
  const targets = new Set<string>()
  for (const op of queue) {
    switch (op.kind) {
      case 'update_task':
        targets.add(`task:${op.taskId}`)
        break
      case 'claim_module':
      case 'release_module':
      case 'renew_reservation':
        targets.add(`reservation:${op.moduleId}`)
        break
      case 'upsert_session':
        targets.add(`session:${op.session.id}`)
        break
      case 'append_activity':
      case 'queue_instruction':
      case 'resolve_instruction':
        targets.add(`session:${op.sessionId}`)
        break
      case 'upsert_integration':
        targets.add(`integration:${op.request.id}`)
        break
      default:
        // Creates target an id nobody else can hold, so they cannot contest.
        break
    }
  }
  if (targets.size === 0) return []

  const advanced = (
    kind: string,
    baseList: readonly { revision: number }[],
    remoteList: readonly { revision: number }[],
    keyOf: (item: never) => string
  ): { kind: string; id: string }[] => {
    const baseByKey = new Map(
      baseList.map((item) => [keyOf(item as never), item.revision])
    )
    const found: { kind: string; id: string }[] = []
    for (const item of remoteList) {
      const id = keyOf(item as never)
      if (!targets.has(`${kind}:${id}`)) continue
      const mine = baseByKey.get(id)
      // Absent locally, or published further ahead than what we based on.
      if (mine === undefined || item.revision > mine) found.push({ kind, id })
    }
    return found
  }

  return [
    ...advanced('task', base.tasks, remote.tasks, (t: Task) => t.id),
    ...advanced(
      'reservation',
      base.reservations,
      remote.reservations,
      (r: ModuleReservation) => r.moduleId
    ),
    ...advanced('session', base.sessions, remote.sessions, (s: AgentSession) => s.id),
    ...advanced(
      'integration',
      base.integrations,
      remote.integrations,
      (i: IntegrationRequest) => i.id
    )
  ]
}

function upsert<T>(list: readonly T[], item: T, keyOf: (item: T) => string): T[] {
  const key = keyOf(item)
  const index = list.findIndex((existing) => keyOf(existing) === key)
  if (index === -1) return [...list, item]
  const next = [...list]
  next[index] = item
  return next
}

function appendEvent(events: readonly CollabEvent[], event: CollabEvent): CollabEvent[] {
  return [...events, event]
}

function placeholderProject(options: GitProviderOptions): CollabProject {
  return {
    id: 'unconfigured',
    name: path.basename(options.repoRoot),
    repositoryUrl: null,
    integratedBranch: 'main',
    architectureVersion: 0,
    settings: DEFAULT_COLLAB_SETTINGS,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    updatedBy: options.developerId
  }
}

export { COLLAB_SCHEMA_VERSION }
