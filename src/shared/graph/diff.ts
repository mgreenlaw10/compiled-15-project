/**
 * Structural diff between two architectures.
 *
 * The GUI records an explicit operation for every edit, and that log is the
 * authoritative statement of *intent* (a `move_file` says "move this", not
 * "this file ended up elsewhere"). This module computes the complementary
 * view: given two graphs, what set of operations takes you from one to the
 * other?
 *
 * It is used to
 *   - summarize "what has changed but is not applied yet" in the status bar,
 *   - verify that replaying the log reproduces the desired graph (a test),
 *   - and derive a work list when a graph arrives from somewhere other than
 *     the local editor, which is exactly the multiplayer case.
 */

import type { ArchitectureGraph, ModuleId } from '../types/architecture'
import type { GraphOperationBody } from '../types/operations'
import { findModule } from './model'

export interface ArchitectureDiff {
  operations: GraphOperationBody[]
  addedModules: ModuleId[]
  removedModules: ModuleId[]
  renamedModules: { id: ModuleId; from: string; to: string }[]
  movedFiles: { file: string; from: ModuleId; to: ModuleId }[]
  addedDependencies: { from: ModuleId; to: ModuleId }[]
  removedDependencies: { from: ModuleId; to: ModuleId }[]
  changedMetadata: ModuleId[]
  /** `true` when nothing at all differs. */
  empty: boolean
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

/**
 * Maps each file in a graph to its owning module id.
 * Files are matched by *basename* when a module's directory was renamed, which
 * is why `diffArchitectures` also consults the rename list.
 */
function fileOwners(graph: ArchitectureGraph): Map<string, ModuleId> {
  const owners = new Map<string, ModuleId>()
  for (const m of graph.modules) {
    for (const f of m.files) owners.set(f, m.id)
  }
  return owners
}

export function diffArchitectures(
  original: ArchitectureGraph,
  desired: ArchitectureGraph
): ArchitectureDiff {
  const operations: GraphOperationBody[] = []
  const originalIds = new Set(original.modules.map((m) => m.id))
  const desiredIds = new Set(desired.modules.map((m) => m.id))

  const addedModules = desired.modules
    .filter((m) => !originalIds.has(m.id))
    .map((m) => m.id)
  const removedModules = original.modules
    .filter((m) => !desiredIds.has(m.id))
    .map((m) => m.id)

  for (const id of addedModules) {
    const m = findModule(desired, id)
    if (!m) continue
    operations.push({
      type: 'add_module',
      module: {
        id: m.id,
        name: m.name,
        description: m.description,
        responsibilities: m.responsibilities,
        directory: m.directory,
        publicInterface: m.publicInterface
      }
    })
  }

  const renamedModules: ArchitectureDiff['renamedModules'] = []
  const changedMetadata: ModuleId[] = []

  for (const after of desired.modules) {
    const before = findModule(original, after.id)
    if (!before) continue

    if (before.name !== after.name || before.directory !== after.directory) {
      renamedModules.push({ id: after.id, from: before.name, to: after.name })
      operations.push({
        type: 'rename_module',
        moduleId: after.id,
        name: after.name,
        directory: after.directory
      })
    }

    const descriptionChanged = before.description !== after.description
    const responsibilitiesChanged = !sameStringSet(
      before.responsibilities,
      after.responsibilities
    )
    const interfaceChanged = !sameStringSet(
      before.publicInterface,
      after.publicInterface
    )
    const tagsChanged = !sameStringSet(
      before.metadata.tags,
      after.metadata.tags
    )
    if (
      descriptionChanged ||
      responsibilitiesChanged ||
      interfaceChanged ||
      tagsChanged
    ) {
      changedMetadata.push(after.id)
      operations.push({
        type: 'update_module',
        moduleId: after.id,
        ...(descriptionChanged ? { description: after.description } : {}),
        ...(responsibilitiesChanged
          ? { responsibilities: after.responsibilities }
          : {}),
        ...(interfaceChanged ? { publicInterface: after.publicInterface } : {}),
        ...(tagsChanged ? { tags: after.metadata.tags } : {})
      })
    }
  }

  // File movement. A file counts as moved when its *owning module* changed.
  // A file whose path changed but whose owner did not is a consequence of that
  // module's directory being renamed, which the rename operation above already
  // covers — emitting a move for it as well would apply the change twice.
  const beforeOwners = fileOwners(original)
  const afterOwners = fileOwners(desired)
  const movedFiles: ArchitectureDiff['movedFiles'] = []

  // Moving a file into a directory-backed module changes its path as well as
  // its owner, so the two sides cannot always be matched on path. Files that
  // vanished from one side and appeared on the other are paired by basename,
  // which is unambiguous as long as the basename is unique among the leftovers.
  const vanished = [...beforeOwners.keys()].filter((f) => !afterOwners.has(f))
  const appeared = [...afterOwners.keys()].filter((f) => !beforeOwners.has(f))
  const appearedByBasename = new Map<string, string[]>()
  for (const file of appeared) {
    const base = file.slice(file.lastIndexOf('/') + 1)
    appearedByBasename.set(base, [...(appearedByBasename.get(base) ?? []), file])
  }

  for (const [file, afterOwner] of afterOwners) {
    const beforeOwner = beforeOwners.get(file)
    if (beforeOwner === undefined || beforeOwner === afterOwner) continue
    movedFiles.push({ file, from: beforeOwner, to: afterOwner })
    operations.push({
      type: 'move_file',
      file,
      fromModuleId: beforeOwner,
      toModuleId: afterOwner
    })
  }

  for (const file of vanished) {
    const base = file.slice(file.lastIndexOf('/') + 1)
    const candidates = appearedByBasename.get(base) ?? []
    if (candidates.length !== 1) continue
    const target = candidates[0]
    const from = beforeOwners.get(file)!
    const to = afterOwners.get(target)!
    if (from === to) continue
    movedFiles.push({ file: target, from, to })
    // The operation names the file by its *original* path, because that is
    // what the transformation engine has to look up on disk.
    operations.push({
      type: 'move_file',
      file,
      fromModuleId: from,
      toModuleId: to
    })
  }

  // Dependencies.
  const beforeEdges = new Map(original.edges.map((e) => [`${e.from}>${e.to}`, e]))
  const afterEdges = new Map(desired.edges.map((e) => [`${e.from}>${e.to}`, e]))
  const addedDependencies: ArchitectureDiff['addedDependencies'] = []
  const removedDependencies: ArchitectureDiff['removedDependencies'] = []

  for (const [key, edge] of afterEdges) {
    if (!beforeEdges.has(key)) {
      addedDependencies.push({ from: edge.from, to: edge.to })
      operations.push({
        type: 'add_dependency',
        from: edge.from,
        to: edge.to,
        kind: edge.kind
      })
    }
  }
  for (const [key, edge] of beforeEdges) {
    // An edge that vanished because one of its modules was deleted is implied
    // by `delete_module`, not a separate dependency removal.
    if (
      !afterEdges.has(key) &&
      desiredIds.has(edge.from) &&
      desiredIds.has(edge.to)
    ) {
      removedDependencies.push({ from: edge.from, to: edge.to })
      operations.push({
        type: 'remove_dependency',
        from: edge.from,
        to: edge.to
      })
    }
  }

  for (const id of removedModules) {
    operations.push({
      type: 'delete_module',
      moduleId: id,
      fileDisposition: 'orphan'
    })
  }

  return {
    operations,
    addedModules,
    removedModules,
    renamedModules,
    movedFiles,
    addedDependencies,
    removedDependencies,
    changedMetadata,
    empty: operations.length === 0
  }
}

/** One-line summary for the status bar. */
export function summarizeDiff(diff: ArchitectureDiff): string {
  if (diff.empty) return 'No architectural changes'
  const parts: string[] = []
  if (diff.addedModules.length) parts.push(`+${diff.addedModules.length} module`)
  if (diff.removedModules.length)
    parts.push(`-${diff.removedModules.length} module`)
  if (diff.renamedModules.length)
    parts.push(`${diff.renamedModules.length} renamed`)
  if (diff.movedFiles.length) parts.push(`${diff.movedFiles.length} file moved`)
  if (diff.addedDependencies.length)
    parts.push(`+${diff.addedDependencies.length} dependency`)
  if (diff.removedDependencies.length)
    parts.push(`-${diff.removedDependencies.length} dependency`)
  if (diff.changedMetadata.length)
    parts.push(`${diff.changedMetadata.length} edited`)
  return parts.join(', ')
}
