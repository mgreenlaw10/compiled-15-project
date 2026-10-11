import type { ArchitectureGraph, ModuleNode } from '../types/architecture'
import type { ModuleComponents, ProgramModel, ProgramSymbol } from '../types/program'

export function stableId(kind: string, key: string): string {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619) }
  return `${kind}-${(hash >>> 0).toString(36)}`
}
export function emptyProgram(): ProgramModel {
  return { symbols: [], relationships: [], contracts: [], fileRelationships: [], assumptions: [] }
}
export function emptyComponents(): ModuleComponents {
  return { interface: { functionIds: [], typeIds: [] }, dataStructures: { symbolIds: [] },
    implementation: { symbolIds: [], observedDescription: '', desiredDescription: null, descriptionOrigin: 'heuristic' },
    contracts: { contractIds: [] } }
}
export const isCallable = (s: ProgramSymbol): boolean => ['function', 'method', 'constructor'].includes(s.kind)
export const isDataType = (s: ProgramSymbol): boolean => ['class', 'struct', 'union', 'record', 'interface', 'enum', 'type'].includes(s.kind)
export function symbolsOf(graph: ArchitectureGraph, module: ModuleNode): ProgramSymbol[] {
  return graph.program.symbols.filter((s) => module.files.includes(s.source.file))
}
export function refreshComponents(graph: ArchitectureGraph): ArchitectureGraph {
  const modules = graph.modules.map((m) => {
    const symbols = symbolsOf(graph, m)
    const ids = new Set(symbols.map((s) => s.id))
    const components = m.components ?? emptyComponents()
    return { ...m, components: {
      interface: { functionIds: symbols.filter((s) => isCallable(s) && s.publiclyAccessible).map((s) => s.id),
        typeIds: symbols.filter((s) => isDataType(s) && s.publiclyAccessible).map((s) => s.id) },
      dataStructures: { symbolIds: symbols.filter(isDataType).map((s) => s.id) },
      implementation: { ...components.implementation, symbolIds: symbols.filter((s) => !s.publiclyAccessible).map((s) => s.id),
        observedDescription: components.implementation.observedDescription ||
          `${symbols.filter(isCallable).length} functions/methods and ${symbols.filter(isDataType).length} types. ` +
          `Internal calls: ${graph.program.relationships.filter((r) => r.kind === 'call' && ids.has(r.fromSymbolId) && !!r.toSymbolId && ids.has(r.toSymbolId)).length}. ` +
          `Implementation details are available in the source-level graph.` },
      contracts: { contractIds: graph.program.contracts.filter((c) => c.moduleId === m.id || !!c.symbolId && ids.has(c.symbolId)).map((c) => c.id) }
    } }
  })
  return { ...graph, modules }
}
/** Additive migration preserves edits and facts in older saved graphs. */
export function migrateGraph(graph: ArchitectureGraph): ArchitectureGraph {
  return { ...graph, schemaVersion: 2, program: graph.program ?? emptyProgram(),
    modules: graph.modules.map((m) => ({ ...m, components: m.components ?? emptyComponents() })) }
}
