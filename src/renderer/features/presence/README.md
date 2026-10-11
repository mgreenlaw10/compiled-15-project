# Presence

Empty on purpose. This is where multi-writer UI goes: who else is in the
session, what they have selected, and whose edit a given change was.

## What already exists

The hard part is done and tested. Operations are the unit of change, and they
already carry everything a merge needs:

- `shared/types/operations.ts` — every edit is plain serializable JSON with an
  `actor` and the graph `baseVersion` it was authored against.
- `shared/graph/apply-operation.ts` — `applyOperations` replays a log onto a
  graph and reports each operation that no longer applies instead of dropping
  it. This is the merge primitive.
- `state/slices/document.ts` — `restoreDocument` is already a merge: it replays
  a saved log onto freshly analyzed source. Catching a client up on someone
  else's edits is the same call.
- `shared/collab/` — `Actor`, `Participant`, `OperationBatch`, `MergeResult`,
  and `colorForActor` (deterministic, so two clients pick the same colour for
  the same person without coordinating).
- `state/slices/session.ts` — holds the local actor and an empty
  `participants` list. `dispatchOperation` already stamps `actor.id`.

## What a build-out looks like

1. **Transport** — a new handler module, `main/ipc/modules/collab.ts`, plus a
   channel group in `shared/ipc/channels.ts` and an `api` fragment in
   `shared/ipc/collab.ts`. Nothing existing needs editing; see
   `shared/ipc/index.ts` for the four-step recipe.
2. **Fan-in** — fold incoming `OperationBatch`es into the local log through
   `applyOperations`, and report rejections into the activity log the way
   `restoreDocument` does. Rejected edits must stay visible: silently dropping
   somebody's change is the worst failure this feature can have.
3. **Presence UI** — components here, fed by `participants`. Avatars in the
   toolbar, selection rings on the canvas, an actor column in the changes tab.
4. **Attribution** — `features/bottom-panel/ChangesTab.tsx` lists pending
   operations; each one already knows its actor.

## Boundaries

Presence is additive. It should not need to change `state/slices/graph.ts`
beyond where the actor comes from, and it should not change how operations are
applied — if it does, the merge primitive is in the wrong place.
