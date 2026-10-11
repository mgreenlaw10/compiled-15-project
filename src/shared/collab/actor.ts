/**
 * Who is making an edit.
 *
 * Every operation already carries an `actor` and the graph `baseVersion` it was
 * written against — the two fields a multi-writer merge needs. This module is
 * the single place that decides what goes in `actor`, so the day a second
 * writer exists there is exactly one definition to change rather than a string
 * literal buried in the renderer's store.
 */

/** A participant in an editing session. */
export interface Actor {
  /** Stable id, unique within a session. Recorded on every operation. */
  id: string
  /** Shown in the activity log and (later) on presence cursors. */
  displayName: string
  kind: 'human' | 'ai'
  /** Hex colour used for presence highlights. */
  color: string
}

/** The actor id used when Cartograph runs single-writer, as it does today. */
export const LOCAL_ACTOR_ID = 'local-user'

export const LOCAL_ACTOR: Actor = {
  id: LOCAL_ACTOR_ID,
  displayName: 'You',
  kind: 'human',
  color: '#6aa6ff'
}

/** The actor recorded for operations the model issues on the user's behalf. */
export const AI_ACTOR: Actor = {
  id: 'ai',
  displayName: 'Assistant',
  kind: 'ai',
  color: '#c08cf5'
}

/**
 * Deterministic colour for an actor id, so two clients independently pick the
 * same colour for the same collaborator without coordinating.
 */
export const PRESENCE_COLORS: readonly string[] = [
  '#6aa6ff',
  '#5fd49a',
  '#f2c14e',
  '#f2706b',
  '#c08cf5',
  '#4ec9c9',
  '#e88b4a',
  '#9aa3b2'
]

export function colorForActor(actorId: string): string {
  let hash = 0
  for (let i = 0; i < actorId.length; i += 1) {
    hash = (hash * 31 + actorId.charCodeAt(i)) | 0
  }
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length]
}
