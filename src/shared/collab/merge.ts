/**
 * Merging two versions of the collaboration state.
 *
 * This is the heart of Git-only collaboration. Two clones will routinely write
 * the coordination branch at the same time, and a textual merge of JSON is both
 * fragile and wrong — so the state is never merged as text. It is merged *by
 * value*, entity by entity:
 *
 *   - **Different entities** → both kept. Alice editing task-1 while Bob edits
 *     task-2 must never lose either, which is an explicit acceptance criterion.
 *   - **Same entity** → higher `revision` wins; ties broken by `updatedAt`,
 *     then by `updatedBy` so the outcome is deterministic on every clone.
 *   - **Append-only lists** (activity, instructions, events, commits) → union
 *     by id. These are the places where "last writer wins" would silently
 *     destroy another developer's work, so they never overwrite.
 *
 * The result is convergent: merging in either order gives the same state, which
 * is what lets a client retry a rejected push without coordination.
 *
 * None of this makes the *semantics* safe. Two developers can still reserve the
 * same module at the same instant and both think they won; that is resolved by
 * `claimModule` re-reading after the push and by validation at integration
 * time, not here.
 */

import type {
  ActivityEntry,
  AgentSession,
  ArchitectureOperationRecord,
  CollabEvent,
  Developer,
  IntegrationRequest,
  Instruction,
  ModuleReservation,
  ProjectState,
  Revisioned,
  Task
} from './model'

/** How many timeline entries to keep. Oldest are dropped first. */
export const MAX_EVENTS = 500
export const MAX_ACTIVITY_PER_SESSION = 400

/**
 * Picks the winner between two versions of one entity.
 *
 * Deterministic on purpose: every clone must choose the same side, or they
 * diverge and keep re-pushing each other's state forever.
 */
export function pickNewer<T extends Revisioned>(a: T, b: T): T {
  if (a.revision !== b.revision) return a.revision > b.revision ? a : b

  const aAt = Date.parse(a.updatedAt)
  const bAt = Date.parse(b.updatedAt)
  const aValid = Number.isFinite(aAt)
  const bValid = Number.isFinite(bAt)
  if (aValid && bValid && aAt !== bAt) return aAt > bAt ? a : b
  if (aValid !== bValid) return aValid ? a : b

  // Same revision and same instant: fall back to the writer id so the choice
  // does not depend on which side happened to be fetched first.
  return a.updatedBy >= b.updatedBy ? a : b
}

/** Merges two keyed collections, entity by entity. */
function mergeById<T extends Revisioned>(
  mine: readonly T[],
  theirs: readonly T[],
  keyOf: (item: T) => string,
  mergeOne: (a: T, b: T) => T = pickNewer
): T[] {
  const byKey = new Map<string, T>()
  for (const item of mine) byKey.set(keyOf(item), item)
  for (const item of theirs) {
    const key = keyOf(item)
    const existing = byKey.get(key)
    byKey.set(key, existing ? mergeOne(existing, item) : item)
  }
  return [...byKey.values()]
}

/** Union by id, oldest first, capped. Never drops an entry someone else added. */
function mergeAppendOnly<T extends { id: string; at: string }>(
  mine: readonly T[],
  theirs: readonly T[],
  cap: number
): T[] {
  const byId = new Map<string, T>()
  for (const entry of [...mine, ...theirs]) {
    // First writer of an id wins: these are immutable once published.
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
  }
  const sorted = [...byId.values()].sort((a, b) => {
    const at = Date.parse(a.at) - Date.parse(b.at)
    return at !== 0 && Number.isFinite(at) ? at : a.id.localeCompare(b.id)
  })
  return sorted.length > cap ? sorted.slice(sorted.length - cap) : sorted
}

/**
 * Instructions are append-only, but their *status* is owned by the execution
 * host: it is the only party that knows whether an instruction was actually
 * applied. So the entry is kept once, and the most advanced status wins.
 */
const INSTRUCTION_PROGRESS: Record<Instruction['status'], number> = {
  pending: 0,
  accepted: 1,
  rejected: 2,
  applied: 3
}

function mergeInstructions(
  mine: readonly Instruction[],
  theirs: readonly Instruction[]
): Instruction[] {
  const byId = new Map<string, Instruction>()
  for (const entry of [...mine, ...theirs]) {
    const existing = byId.get(entry.id)
    if (!existing) {
      byId.set(entry.id, entry)
      continue
    }
    const keep =
      INSTRUCTION_PROGRESS[entry.status] > INSTRUCTION_PROGRESS[existing.status]
        ? entry
        : existing
    byId.set(entry.id, keep)
  }
  return [...byId.values()].sort((a, b) => {
    const at = Date.parse(a.at) - Date.parse(b.at)
    return at !== 0 && Number.isFinite(at) ? at : a.id.localeCompare(b.id)
  })
}

function mergeActivity(
  mine: readonly ActivityEntry[],
  theirs: readonly ActivityEntry[]
): ActivityEntry[] {
  return mergeAppendOnly(mine, theirs, MAX_ACTIVITY_PER_SESSION)
}

/**
 * Sessions need a hybrid merge: the record itself is revisioned, but its
 * activity log and instruction queue are append-only and must survive a losing
 * revision. Taking the winner's scalars and the union of both lists is what
 * lets a watcher queue an instruction while the host is writing progress.
 */
function mergeSession(a: AgentSession, b: AgentSession): AgentSession {
  const winner = pickNewer(a, b)
  return {
    ...winner,
    activity: mergeActivity(a.activity, b.activity),
    instructions: mergeInstructions(a.instructions, b.instructions),
    commits: [...new Set([...a.commits, ...b.commits])]
  }
}

/** Integration conflicts and validations belong to whichever run is newer. */
function mergeIntegration(
  a: IntegrationRequest,
  b: IntegrationRequest
): IntegrationRequest {
  return pickNewer(a, b)
}

export interface MergeStateResult {
  state: ProjectState
  /** Entities where both sides had changed the same record. */
  contested: { kind: string; id: string }[]
}

/**
 * Merges `theirs` (the remote) into `mine` (local), returning the convergent
 * result plus whatever was contested, for the activity log.
 *
 * Contested does not mean lost: one side's value won, and the loser's write is
 * reported so a user is never left believing a change landed when it did not.
 */
export function mergeProjectState(
  mine: ProjectState,
  theirs: ProjectState
): MergeStateResult {
  const contested: { kind: string; id: string }[] = []

  const track =
    <T extends Revisioned>(kind: string, keyOf: (item: T) => string) =>
    (a: T, b: T): T => {
      if (a.revision === b.revision && a.updatedBy !== b.updatedBy) {
        contested.push({ kind, id: keyOf(a) })
      }
      return pickNewer(a, b)
    }

  const taskKey = (t: Task): string => t.id
  const devKey = (d: Developer): string => d.id
  const resKey = (r: ModuleReservation): string => r.moduleId
  const sessKey = (s: AgentSession): string => s.id
  const opKey = (o: ArchitectureOperationRecord): string => o.id
  const intKey = (i: IntegrationRequest): string => i.id

  return {
    state: {
      schemaVersion: Math.max(mine.schemaVersion, theirs.schemaVersion),
      project: pickNewer(mine.project, theirs.project),
      developers: mergeById(
        mine.developers,
        theirs.developers,
        devKey,
        track<Developer>('developer', devKey)
      ),
      tasks: mergeById(mine.tasks, theirs.tasks, taskKey, track<Task>('task', taskKey)),
      reservations: mergeById(
        mine.reservations,
        theirs.reservations,
        resKey,
        track<ModuleReservation>('reservation', resKey)
      ),
      sessions: mergeById(mine.sessions, theirs.sessions, sessKey, mergeSession),
      operations: mergeById(
        mine.operations,
        theirs.operations,
        opKey,
        track<ArchitectureOperationRecord>('operation', opKey)
      ),
      integrations: mergeById(
        mine.integrations,
        theirs.integrations,
        intKey,
        mergeIntegration
      ),
      events: mergeAppendOnly<CollabEvent>(mine.events, theirs.events, MAX_EVENTS)
    },
    contested
  }
}

/** Bumps an entity for a local write. The only way `revision` should move. */
export function touch<T extends Revisioned>(
  entity: T,
  developerId: string,
  now = new Date()
): T {
  return {
    ...entity,
    revision: entity.revision + 1,
    updatedAt: now.toISOString(),
    updatedBy: developerId
  }
}

/** A fresh entity's revisioned fields. */
export function initialRevision(
  developerId: string,
  now = new Date()
): Revisioned {
  return { revision: 1, updatedAt: now.toISOString(), updatedBy: developerId }
}
