/**
 * How collaboration state is laid out on the coordination branch.
 *
 * One file per entity kind, not one big blob. Two clones that touch different
 * kinds then do not even write the same object, which keeps the common case
 * cheap. State is still merged by value (`shared/collab/merge.ts`) rather than
 * by text, so the split is an optimization, not the correctness mechanism.
 *
 * Nothing here holds a local path, an API key or a token: this content is
 * pushed to a shared remote. Worktree locations stay in each install's own
 * settings.
 */

import {
  COLLAB_SCHEMA_VERSION,
  emptyProjectState,
  type CollabProject,
  type ProjectState
} from '../../shared/collab'

/** The branch coordination metadata lives on. Never holds project source. */
export const COLLAB_BRANCH = 'collab-state'

/** Directory on that branch, so the root stays legible if anyone checks it out. */
const ROOT = 'collab'

export const COLLAB_FILES = {
  project: `${ROOT}/project.json`,
  developers: `${ROOT}/developers.json`,
  tasks: `${ROOT}/tasks.json`,
  reservations: `${ROOT}/reservations.json`,
  sessions: `${ROOT}/sessions.json`,
  operations: `${ROOT}/operations.json`,
  integrations: `${ROOT}/integrations.json`,
  events: `${ROOT}/events.json`,
  readme: `${ROOT}/README.md`
} as const

const README = `# Cartograph coordination branch

This branch holds **collaboration metadata only** — tasks, module reservations,
agent session history and integration requests. It deliberately contains no
project source code, and it is an orphan branch, so it shares no history with
your code branches.

Cartograph reads and writes these files without ever checking this branch out,
so it cannot disturb your working tree.

Do not edit these files by hand while the application is running: it merges
them by value and will overwrite a hand edit it did not expect. Nothing here is
secret, but nothing here is authenticated either — Git author names are
attribution, not identity. Repository access is controlled by your Git host.
`

/** Pretty-printed with a trailing newline, so textual diffs stay readable. */
function encode(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function decode<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw.trim() === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    // A corrupt file must not make the project unopenable. The caller reports
    // it; losing one entity kind beats refusing to load at all.
    return fallback
  }
}

/** The state, as the set of files to commit. */
export function serializeState(state: ProjectState): Record<string, string> {
  return {
    [COLLAB_FILES.readme]: README,
    [COLLAB_FILES.project]: encode({
      schemaVersion: state.schemaVersion,
      project: state.project
    }),
    [COLLAB_FILES.developers]: encode(state.developers),
    [COLLAB_FILES.tasks]: encode(state.tasks),
    [COLLAB_FILES.reservations]: encode(state.reservations),
    [COLLAB_FILES.sessions]: encode(state.sessions),
    [COLLAB_FILES.operations]: encode(state.operations),
    [COLLAB_FILES.integrations]: encode(state.integrations),
    [COLLAB_FILES.events]: encode(state.events)
  }
}

export interface DeserializeInput {
  project: string | null
  developers: string | null
  tasks: string | null
  reservations: string | null
  sessions: string | null
  operations: string | null
  integrations: string | null
  events: string | null
}

export function deserializeState(
  raw: DeserializeInput,
  fallbackProject: CollabProject
): ProjectState {
  const header = decode<{ schemaVersion?: number; project?: CollabProject }>(
    raw.project,
    {}
  )
  const base = emptyProjectState(header.project ?? fallbackProject)

  return {
    schemaVersion: header.schemaVersion ?? COLLAB_SCHEMA_VERSION,
    project: header.project ?? fallbackProject,
    developers: decode(raw.developers, base.developers),
    tasks: decode(raw.tasks, base.tasks),
    reservations: decode(raw.reservations, base.reservations),
    sessions: decode(raw.sessions, base.sessions),
    operations: decode(raw.operations, base.operations),
    integrations: decode(raw.integrations, base.integrations),
    events: decode(raw.events, base.events)
  }
}
