/**
 * Pure constructors, lookups, and invariant checks for the architecture model.
 *
 * Nothing in this file performs IO or depends on the GUI. The analyzer, the
 * renderer, and the transformation engine all build graphs through these
 * helpers so that a graph is shaped identically no matter who made it.
 */

import {
  ARCHITECTURE_SCHEMA_VERSION,
  LAYOUT_SCHEMA_VERSION,
  type AnalysisSummary,
  type ArchitectureGraph,
  type DependencyEdge,
  type DependencyKind,
  type GraphLayout,
  type ModuleId,
  type ModuleNode,
  type Provenance
} from '../types/architecture'
import { edgeId } from '../util/id'
import { emptyComponents, emptyProgram } from './program'

export function emptyAnalysisSummary(): AnalysisSummary {
  return {
    analyzedAt: new Date(0).toISOString(),
    analyzerVersion: '0',
    durationMs: 0,
    fileCount: 0,
    skippedFileCount: 0,
    loc: 0,
    languages: {},
    sourceRoots: [],
    aiAssisted: false,
    warnings: []
  }
}

export function createModule(init: {
  id: ModuleId
  name: string
  description?: string
  responsibilities?: string[]
  files?: string[]
  directory?: string | null
  publicInterface?: string[]
  externalDependencies?: string[]
  origin?: Provenance
  confidence?: number
  confidenceBasis?: Provenance
  notes?: string[]
  loc?: number
  tags?: string[]
}): ModuleNode {
  return {
    id: init.id,
    name: init.name,
    description: init.description ?? '',
    responsibilities: init.responsibilities ?? [],
    files: [...(init.files ?? [])].sort(),
    symbols: [],
    publicInterface: init.publicInterface ?? [],
    directory: init.directory ?? null,
    externalDependencies: init.externalDependencies ?? [],
    origin: init.origin ?? 'user',
    metadata: {
      confidence: init.confidence ?? 1,
      confidenceBasis: init.confidenceBasis ?? init.origin ?? 'user',
      notes: init.notes ?? [],
      loc: init.loc ?? 0,
      tags: init.tags ?? [],
      owner: null,
      lockedBy: null
    },
    version: 1,
    components: emptyComponents()
  }
}

export function createEdge(init: {
  from: ModuleId
  to: ModuleId
  kind?: DependencyKind
  weight?: number
  verified?: boolean
  confidence?: number
  origin?: Provenance
}): DependencyEdge {
  const kind = init.kind ?? 'imports'
  return {
    id: edgeId(init.from, init.to, kind),
    from: init.from,
    to: init.to,
    kind,
    weight: init.weight ?? 1,
    verified: init.verified ?? false,
    confidence: init.confidence ?? (init.verified ? 1 : 0.5),
    evidence: [],
    origin: init.origin ?? 'user',
    version: 1
  }
}

export function createGraph(init: {
  projectRoot: string
  name: string
  modules?: ModuleNode[]
  edges?: DependencyEdge[]
  unassignedFiles?: string[]
  analysis?: AnalysisSummary
}): ArchitectureGraph {
  return {
    schemaVersion: ARCHITECTURE_SCHEMA_VERSION,
    projectRoot: init.projectRoot,
    name: init.name,
    modules: init.modules ?? [],
    edges: init.edges ?? [],
    unassignedFiles: init.unassignedFiles ?? [],
    version: 1,
    analysis: init.analysis ?? emptyAnalysisSummary(),
    program: emptyProgram()
  }
}

export function createLayout(
  positions: Record<ModuleId, { x: number; y: number }> = {}
): GraphLayout {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    positions,
    expanded: {},
    algorithm: 'layered',
    version: 1
  }
}

export function findModule(
  graph: ArchitectureGraph,
  id: ModuleId
): ModuleNode | undefined {
  return graph.modules.find((m) => m.id === id)
}

export function requireModule(
  graph: ArchitectureGraph,
  id: ModuleId
): ModuleNode {
  const found = findModule(graph, id)
  if (!found) throw new Error(`Module not found: ${id}`)
  return found
}

/** The module that currently owns `file`, if any. */
export function moduleOfFile(
  graph: ArchitectureGraph,
  file: string
): ModuleNode | undefined {
  return graph.modules.find((m) => m.files.includes(file))
}

export function allFiles(graph: ArchitectureGraph): string[] {
  return graph.modules.flatMap((m) => m.files)
}

export function findEdge(
  graph: ArchitectureGraph,
  from: ModuleId,
  to: ModuleId
): DependencyEdge | undefined {
  return graph.edges.find((e) => e.from === from && e.to === to)
}

export function cloneGraph(graph: ArchitectureGraph): ArchitectureGraph {
  return structuredClone(graph)
}

export interface GraphProblem {
  severity: 'error' | 'warning'
  message: string
  moduleId?: ModuleId
  edgeId?: string
}

/**
 * Checks the invariants the rest of the system relies on. Called after every
 * operation in dev and by the tests; cheap enough to run on each edit.
 */
export function validateGraph(graph: ArchitectureGraph): GraphProblem[] {
  const problems: GraphProblem[] = []
  const ids = new Set<string>()

  for (const m of graph.modules) {
    if (ids.has(m.id)) {
      problems.push({
        severity: 'error',
        message: `Duplicate module id "${m.id}"`,
        moduleId: m.id
      })
    }
    ids.add(m.id)
    if (m.name.trim() === '') {
      problems.push({
        severity: 'error',
        message: `Module "${m.id}" has an empty name`,
        moduleId: m.id
      })
    }
  }

  const seenFiles = new Map<string, ModuleId>()
  for (const m of graph.modules) {
    for (const f of m.files) {
      const owner = seenFiles.get(f)
      if (owner !== undefined) {
        problems.push({
          severity: 'error',
          message: `File "${f}" is claimed by both "${owner}" and "${m.id}"`,
          moduleId: m.id
        })
      }
      seenFiles.set(f, m.id)
    }
  }

  for (const e of graph.edges) {
    if (!ids.has(e.from)) {
      problems.push({
        severity: 'error',
        message: `Edge ${e.id} starts at unknown module "${e.from}"`,
        edgeId: e.id
      })
    }
    if (!ids.has(e.to)) {
      problems.push({
        severity: 'error',
        message: `Edge ${e.id} ends at unknown module "${e.to}"`,
        edgeId: e.id
      })
    }
    if (e.from === e.to) {
      problems.push({
        severity: 'warning',
        message: `Edge ${e.id} is a self-dependency`,
        edgeId: e.id
      })
    }
  }

  for (const m of graph.modules) {
    if (m.files.length === 0 && m.origin === 'analysis') {
      problems.push({
        severity: 'warning',
        message: `Analyzed module "${m.name}" has no files`,
        moduleId: m.id
      })
    }
  }

  return problems
}
