/**
 * Editing-session shape.
 *
 * Cartograph is single-writer today: one window, one actor, one operation log
 * kept in the renderer and saved to `.cartograph/`. These types describe the
 * same thing in terms that generalise, so that concurrent editing is a new
 * transport behind an existing boundary rather than a redesign.
 *
 * The merge primitive already exists and is already tested: `applyOperations`
 * in `shared/graph/apply-operation.ts` replays a log onto a graph and reports
 * each operation that no longer applies instead of dropping it. Catching a
 * client up on someone else's edits is the same call that
 * `restoreDocument` makes when it replays a saved log onto freshly analyzed
 * source.
 */

import type { GraphOperation } from '../types/operations'
import type { Actor } from './actor'

/** One participant's live state, for presence indicators. */
export interface Participant {
  actor: Actor
  /** Last time anything was heard from them, ISO 8601. */
  lastSeenAt: string
  /** Module they currently have selected, when known. */
  selectedModuleId: string | null
}

/**
 * A batch of operations from one actor, stamped with the log position it was
 * written against. The position is what lets a receiver tell "this was authored
 * without knowing about my last edit" from "this already accounts for it".
 */
export interface OperationBatch {
  actorId: string
  /** Number of operations in the shared log the author had seen. */
  sinceSequence: number
  operations: GraphOperation[]
}

/** The result of folding a remote batch into the local log. */
export interface MergeResult {
  /** Operations accepted, in the order they should be replayed. */
  accepted: GraphOperation[]
  /** Operations that could not be applied, with the reason, for the log. */
  rejected: { operationId: string; reason: string }[]
  /** New length of the shared log. */
  sequence: number
}
