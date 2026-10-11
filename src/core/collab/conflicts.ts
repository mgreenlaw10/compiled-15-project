/**
 * Detecting incompatible concurrent changes.
 *
 * Git can tell you two branches touched the same lines. It cannot tell you that
 * Agent A changed `validateToken`'s return type while Agent B wrote code that
 * calls it — those branches merge cleanly and the result does not compile. That
 * gap is what this module closes, using the program graph the analyzer already
 * produces.
 *
 * Five kinds, in increasing order of how much interpretation they need:
 *
 *   1. **file** — overlapping edits to the same file. A fact, from Git.
 *   2. **shared_config** — both sides touched build files or manifests. A fact.
 *   3. **interface** — a public symbol changed that another module calls. A
 *      fact about the dependency; a judgement about whether it breaks.
 *   4. **data_structure** — a shared type's fields changed.
 *   5. **contract** — a behavioural guarantee may no longer hold. Always a
 *      suspicion, never a proof.
 *
 * `severity` keeps that honest: `blocking` means we know the merge is unsafe,
 * `warning` means it deserves a human. Presenting a suspicion as a proof trains
 * people to ignore the warnings, which is worse than not warning at all.
 */

import type {
  ArchitectureGraph,
  ModuleId
} from '../../shared/types/architecture'
import type { ProgramSymbol, SymbolRelationship } from '../../shared/types/program'
import type { IntegrationConflict } from '../../shared/collab'
import { normalizeRel } from '../../shared/util/paths'
import { isSharedConfigPath, ownerOf } from './scope'

/** One side of a comparison: what a branch changed. */
export interface ChangeSetSummary {
  taskId: string
  /** Modules the task owns. */
  moduleIds: ModuleId[]
  /** Project-relative POSIX paths the branch changed. */
  changedPaths: string[]
  /** The program graph as it looks on that branch, when it was analyzed. */
  graph: ArchitectureGraph | null
}

/** A symbol whose observable surface changed between two analyses. */
export interface SymbolChange {
  symbolId: string
  name: string
  qualifiedName: string
  moduleId: ModuleId | null
  kind: 'removed' | 'signature' | 'return_type' | 'parameters' | 'fields'
  before: string
  after: string
  publiclyAccessible: boolean
}

function signatureOf(symbol: ProgramSymbol): string {
  return symbol.signature.trim() !== ''
    ? symbol.signature.trim()
    : `${symbol.name}(${symbol.parameters.map((p) => `${p.name}: ${p.type}`).join(', ')}): ${symbol.returnType}`
}

function fieldsOf(symbol: ProgramSymbol): string {
  return symbol.fields.map((f) => `${f.name}: ${f.type}`).join('; ')
}

/** Which module a symbol belongs to, via the file it is declared in. */
function moduleOfSymbol(
  graph: ArchitectureGraph,
  symbol: ProgramSymbol
): ModuleId | null {
  return ownerOf(graph, symbol.source.file)
}

/**
 * Compares two analyses of the same project and reports what changed about the
 * symbols a *caller* could notice.
 *
 * Private, internal and non-exported symbols are skipped: churn inside a module
 * is exactly the parallel work this system exists to allow.
 */
export function diffPublicSurface(
  before: ArchitectureGraph,
  after: ArchitectureGraph
): SymbolChange[] {
  const changes: SymbolChange[] = []
  const afterById = new Map(after.program.symbols.map((s) => [s.id, s]))

  for (const old of before.program.symbols) {
    if (!old.publiclyAccessible) continue

    const now = afterById.get(old.id)
    if (!now) {
      changes.push({
        symbolId: old.id,
        name: old.name,
        qualifiedName: old.qualifiedName,
        moduleId: moduleOfSymbol(before, old),
        kind: 'removed',
        before: signatureOf(old),
        after: '(removed)',
        publiclyAccessible: true
      })
      continue
    }

    const moduleId = moduleOfSymbol(after, now) ?? moduleOfSymbol(before, old)

    if (old.returnType !== now.returnType && old.returnType !== '') {
      changes.push({
        symbolId: old.id,
        name: old.name,
        qualifiedName: old.qualifiedName,
        moduleId,
        kind: 'return_type',
        before: old.returnType,
        after: now.returnType,
        publiclyAccessible: true
      })
      continue
    }

    const oldParams = old.parameters.map((p) => `${p.name}:${p.type}`).join(',')
    const newParams = now.parameters.map((p) => `${p.name}:${p.type}`).join(',')
    if (oldParams !== newParams) {
      changes.push({
        symbolId: old.id,
        name: old.name,
        qualifiedName: old.qualifiedName,
        moduleId,
        kind: 'parameters',
        before: oldParams || '(none)',
        after: newParams || '(none)',
        publiclyAccessible: true
      })
      continue
    }

    const oldFields = fieldsOf(old)
    const newFields = fieldsOf(now)
    if (oldFields !== newFields) {
      changes.push({
        symbolId: old.id,
        name: old.name,
        qualifiedName: old.qualifiedName,
        moduleId,
        kind: 'fields',
        before: oldFields || '(none)',
        after: newFields || '(none)',
        publiclyAccessible: true
      })
      continue
    }

    if (signatureOf(old) !== signatureOf(now)) {
      changes.push({
        symbolId: old.id,
        name: old.name,
        qualifiedName: old.qualifiedName,
        moduleId,
        kind: 'signature',
        before: signatureOf(old),
        after: signatureOf(now),
        publiclyAccessible: true
      })
    }
  }

  return changes
}

/** Everything that references a symbol from outside its own module. */
export function externalDependentsOf(
  graph: ArchitectureGraph,
  symbolId: string,
  owningModuleId: ModuleId | null
): { moduleId: ModuleId; relationship: SymbolRelationship }[] {
  const symbolsById = new Map(graph.program.symbols.map((s) => [s.id, s]))
  const found: { moduleId: ModuleId; relationship: SymbolRelationship }[] = []

  for (const relationship of graph.program.relationships) {
    if (relationship.toSymbolId !== symbolId) continue
    const from = symbolsById.get(relationship.fromSymbolId)
    if (!from) continue
    const moduleId = ownerOf(graph, from.source.file)
    // Intra-module references are the module's own business.
    if (!moduleId || moduleId === owningModuleId) continue
    found.push({ moduleId, relationship })
  }
  return found
}

export interface ConflictOptions {
  /** The integrated graph, used to resolve who depends on what. */
  baseGraph: ArchitectureGraph
  /** The change being integrated. */
  incoming: ChangeSetSummary
  /** Other work in flight, for cross-task warnings. */
  others?: ChangeSetSummary[]
  /** Paths Git reported as genuinely conflicting, when a trial merge ran. */
  gitConflictPaths?: string[]
}

/**
 * The whole analysis: Git facts first, then architectural inference.
 *
 * Returned sorted with blocking conflicts first, because the first line of the
 * report is the one people read.
 */
export function detectConflicts(options: ConflictOptions): IntegrationConflict[] {
  const { baseGraph, incoming } = options
  const conflicts: IntegrationConflict[] = []
  const nameOf = (id: ModuleId | null): string =>
    baseGraph.modules.find((m) => m.id === id)?.name ?? id ?? 'an unknown module'

  // --- 1. file-level, straight from Git -----------------------------------
  const gitConflicts = options.gitConflictPaths ?? []
  if (gitConflicts.length > 0) {
    conflicts.push({
      kind: 'file',
      severity: 'blocking',
      summary: `${gitConflicts.length} file(s) cannot be merged automatically`,
      explanation:
        `Git could not reconcile overlapping edits to ${gitConflicts
          .slice(0, 5)
          .join(', ')}${gitConflicts.length > 5 ? ', and others' : ''}. ` +
        'These need a human merge before the task can be integrated.',
      paths: gitConflicts,
      affectedModuleIds: [
        ...new Set(
          gitConflicts.map((p) => ownerOf(baseGraph, p)).filter((id): id is ModuleId => id !== null)
        )
      ],
      symbolIds: [],
      withTaskIds: []
    })
  }

  // --- 2. overlapping files with other in-flight tasks --------------------
  const incomingPaths = new Set(incoming.changedPaths.map(normalizeRel))
  for (const other of options.others ?? []) {
    if (other.taskId === incoming.taskId) continue
    const overlap = other.changedPaths
      .map(normalizeRel)
      .filter((p) => incomingPaths.has(p))
    if (overlap.length === 0) continue

    conflicts.push({
      kind: 'file',
      severity: 'warning',
      summary: `${overlap.length} file(s) are also being changed by ${other.taskId}`,
      explanation:
        `Another task in flight (${other.taskId}) has modified ${overlap.slice(0, 5).join(', ')}. ` +
        'Whichever integrates second will have to reconcile these.',
      paths: overlap,
      affectedModuleIds: [...new Set([...incoming.moduleIds, ...other.moduleIds])],
      symbolIds: [],
      withTaskIds: [other.taskId]
    })
  }

  // --- 3. shared configuration --------------------------------------------
  const sharedPaths = incoming.changedPaths.filter(isSharedConfigPath)
  if (sharedPaths.length > 0) {
    const alsoTouching = (options.others ?? []).filter((other) =>
      other.changedPaths.some(isSharedConfigPath)
    )
    conflicts.push({
      kind: 'shared_config',
      severity: alsoTouching.length > 0 ? 'blocking' : 'warning',
      summary: `Shared configuration changed: ${sharedPaths.slice(0, 3).join(', ')}`,
      explanation:
        alsoTouching.length > 0
          ? `This task and ${alsoTouching
              .map((o) => o.taskId)
              .join(', ')} both modify project-wide configuration. These changes affect every module, and two tasks editing them will collide even though their modules do not overlap.`
          : 'This task modifies project-wide configuration (build files, dependency manifests or similar). Changes here affect every module, not just the ones the task owns.',
      paths: sharedPaths,
      affectedModuleIds: baseGraph.modules.map((m) => m.id),
      symbolIds: [],
      withTaskIds: alsoTouching.map((o) => o.taskId)
    })
  }

  // --- 4..6. architectural changes, when the branch was analyzed ----------
  if (incoming.graph) {
    const surfaceChanges = diffPublicSurface(baseGraph, incoming.graph)

    for (const change of surfaceChanges) {
      const dependents = externalDependentsOf(baseGraph, change.symbolId, change.moduleId)

      // A changed symbol nobody outside the module uses is just internal work.
      if (dependents.length === 0) continue

      const affectedModuleIds = [...new Set(dependents.map((d) => d.moduleId))]
      const otherTasks = (options.others ?? [])
        .filter((other) => other.moduleIds.some((id) => affectedModuleIds.includes(id)))
        .map((other) => other.taskId)

      const isDataStructure = change.kind === 'fields'
      conflicts.push({
        kind: isDataStructure ? 'data_structure' : 'interface',
        // A removal provably breaks callers. A signature change usually does
        // but we have not type-checked it yet, so it is a warning until
        // validation says otherwise.
        severity: change.kind === 'removed' ? 'blocking' : 'warning',
        summary: `${nameOf(change.moduleId)}.${change.name}${
          change.kind === 'removed' ? ' was removed' : ' changed'
        }`,
        explanation: explainSurfaceChange(change, affectedModuleIds.map(nameOf)),
        paths: [],
        affectedModuleIds,
        symbolIds: [change.symbolId],
        withTaskIds: [...new Set(otherTasks)]
      })
    }

    // --- contracts --------------------------------------------------------
    const baseContracts = new Map(
      baseGraph.program.contracts.map((c) => [c.id, c])
    )
    for (const contract of incoming.graph.program.contracts) {
      const old = baseContracts.get(contract.id)
      if (!old || old.description === contract.description) continue

      const moduleId = contract.moduleId ?? null
      const dependents = contract.symbolId
        ? externalDependentsOf(baseGraph, contract.symbolId, moduleId)
        : []
      if (dependents.length === 0) continue

      conflicts.push({
        kind: 'contract',
        // Never blocking: a changed contract description is evidence that
        // behaviour may have changed, not proof that anything is broken.
        severity: 'warning',
        summary: `A behavioural contract on ${nameOf(moduleId)} changed`,
        explanation:
          `The ${contract.category} "${old.description}" is now "${contract.description}". ` +
          `${[...new Set(dependents.map((d) => nameOf(d.moduleId)))].join(', ')} depend(s) on this symbol and may rely on the previous behaviour. ` +
          'This is a suspected incompatibility, not a proven one — the contract is ' +
          `${contract.verification === 'unverified' ? 'unverified' : contract.verification}.`,
        paths: [],
        affectedModuleIds: [...new Set(dependents.map((d) => d.moduleId))],
        symbolIds: contract.symbolId ? [contract.symbolId] : [],
        withTaskIds: []
      })
    }
  }

  return conflicts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : 1
    return a.kind.localeCompare(b.kind)
  })
}

function explainSurfaceChange(
  change: SymbolChange,
  dependentModuleNames: string[]
): string {
  const who = dependentModuleNames.join(', ')
  switch (change.kind) {
    case 'removed':
      return `${change.qualifiedName} no longer exists. ${who} reference(s) it, so those modules will stop compiling.`
    case 'return_type':
      return `Return type changed from ${change.before} to ${change.after}. ${who} call(s) this and may expect the previous type.`
    case 'parameters':
      return `Parameters changed from (${change.before}) to (${change.after}). ${who} call(s) this and will need updating if the change is not backward-compatible.`
    case 'fields':
      return `Fields changed from ${change.before} to ${change.after}. ${who} read(s) or write(s) this structure.`
    default:
      return `Signature changed from ${change.before} to ${change.after}. ${who} depend(s) on this symbol.`
  }
}

/** A short, plain-text report, for the activity log and the CLI. */
export function formatConflictReport(
  conflicts: readonly IntegrationConflict[]
): string {
  if (conflicts.length === 0) return 'No conflicts detected.'

  const lines: string[] = []
  for (const conflict of conflicts) {
    lines.push(
      `${conflict.severity === 'blocking' ? 'Conflict' : 'Warning'} (${conflict.kind}): ${conflict.summary}`,
      `  ${conflict.explanation}`
    )
    if (conflict.affectedModuleIds.length > 0) {
      lines.push(`  Affected: ${conflict.affectedModuleIds.join(', ')}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
