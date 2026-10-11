/**
 * Read-only queries over the architecture graph.
 *
 * Kept out of the React components so the same questions can be asked by the
 * AI agent's `query_graph` tool, by the transformation engine, and by tests.
 */

import type {
  ArchitectureGraph,
  DependencyEdge,
  ModuleId,
  ModuleNode,
  SourceSymbol
} from '../types/architecture'
import { dirname, isWithin } from '../util/paths'

export interface ModuleStats {
  fileCount: number
  loc: number
  exportCount: number
  dependencyCount: number
  dependentCount: number
  unverifiedDependencyCount: number
}

export function moduleStats(
  graph: ArchitectureGraph,
  id: ModuleId
): ModuleStats {
  const m = graph.modules.find((x) => x.id === id)
  const out = graph.edges.filter((e) => e.from === id)
  return {
    fileCount: m?.files.length ?? 0,
    loc: m?.metadata.loc ?? 0,
    exportCount: m?.publicInterface.length ?? 0,
    dependencyCount: out.length,
    dependentCount: graph.edges.filter((e) => e.to === id).length,
    unverifiedDependencyCount: out.filter((e) => !e.verified).length
  }
}

/** Modules that `id` depends on. */
export function dependenciesOf(
  graph: ArchitectureGraph,
  id: ModuleId
): { edge: DependencyEdge; module: ModuleNode }[] {
  return graph.edges
    .filter((e) => e.from === id)
    .map((edge) => ({
      edge,
      module: graph.modules.find((m) => m.id === edge.to)
    }))
    .filter((x): x is { edge: DependencyEdge; module: ModuleNode } =>
      Boolean(x.module)
    )
}

/** Modules that depend on `id`. */
export function dependentsOf(
  graph: ArchitectureGraph,
  id: ModuleId
): { edge: DependencyEdge; module: ModuleNode }[] {
  return graph.edges
    .filter((e) => e.to === id)
    .map((edge) => ({
      edge,
      module: graph.modules.find((m) => m.id === edge.from)
    }))
    .filter((x): x is { edge: DependencyEdge; module: ModuleNode } =>
      Boolean(x.module)
    )
}

/** Symbols the analyzer considered notable, most significant first. */
export function importantSymbols(
  module: ModuleNode,
  limit = 12
): SourceSymbol[] {
  return [...module.symbols]
    .sort((a, b) => {
      if (a.exported !== b.exported) return a.exported ? -1 : 1
      if (a.loc !== b.loc) return b.loc - a.loc
      return a.name.localeCompare(b.name)
    })
    .slice(0, limit)
}

/** Dependency cycles between modules, as id paths. */
export function findCycles(graph: ArchitectureGraph): ModuleId[][] {
  const adjacency = new Map<ModuleId, ModuleId[]>()
  for (const m of graph.modules) adjacency.set(m.id, [])
  for (const e of graph.edges) {
    if (e.from !== e.to) adjacency.get(e.from)?.push(e.to)
  }

  const cycles: ModuleId[][] = []
  const state = new Map<ModuleId, 'white' | 'grey' | 'black'>()
  for (const m of graph.modules) state.set(m.id, 'white')
  const stack: ModuleId[] = []

  const visit = (id: ModuleId): void => {
    state.set(id, 'grey')
    stack.push(id)
    for (const next of (adjacency.get(id) ?? []).slice().sort()) {
      const s = state.get(next)
      if (s === 'white') visit(next)
      else if (s === 'grey') {
        const start = stack.indexOf(next)
        if (start >= 0) cycles.push([...stack.slice(start), next])
      }
    }
    stack.pop()
    state.set(id, 'black')
  }

  for (const id of graph.modules.map((m) => m.id).sort()) {
    if (state.get(id) === 'white') visit(id)
  }
  return cycles
}

/**
 * The module a file should belong to based on directories alone. Used when a
 * new file appears, and by the AI agent when it creates files.
 */
export function suggestModuleForFile(
  graph: ArchitectureGraph,
  file: string
): ModuleNode | undefined {
  const dir = dirname(file)
  const candidates = graph.modules
    .filter((m) => m.directory !== null && isWithin(m.directory, dir))
    .sort((a, b) => (b.directory ?? '').length - (a.directory ?? '').length)
  return candidates[0]
}

export interface SearchHit {
  kind: 'module' | 'file' | 'symbol'
  moduleId: ModuleId
  label: string
  detail: string
}

export function searchGraph(
  graph: ArchitectureGraph,
  query: string,
  limit = 40
): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const hits: SearchHit[] = []

  for (const m of graph.modules) {
    if (
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      m.responsibilities.some((r) => r.toLowerCase().includes(q))
    ) {
      hits.push({
        kind: 'module',
        moduleId: m.id,
        label: m.name,
        detail: m.description || m.directory || m.id
      })
    }
    for (const f of m.files) {
      if (f.toLowerCase().includes(q)) {
        hits.push({ kind: 'file', moduleId: m.id, label: f, detail: m.name })
      }
    }
    for (const s of m.symbols) {
      if (s.name.toLowerCase().includes(q)) {
        hits.push({
          kind: 'symbol',
          moduleId: m.id,
          label: s.name,
          detail: `${s.kind} in ${s.file}`
        })
      }
    }
  }
  return hits.slice(0, limit)
}
