import type { ArchitectureGraph, DependencyKind } from '../../shared/types/architecture'
import type { ProgramModel } from '../../shared/types/program'
import { refreshComponents } from '../../shared/graph/program'
import { edgeId } from '../../shared/util/id'

export function attachProgram(graph: ArchitectureGraph, program: ProgramModel): ArchitectureGraph {
  const owners = new Map(graph.modules.flatMap((m) => m.files.map((f) => [f, m.id] as const)))
  const symbols = new Map(program.symbols.map((s) => [s.id, s]))
  const edges = [...graph.edges]
  for (const contract of program.contracts) {
    if (contract.symbolId) contract.moduleId = owners.get(symbols.get(contract.symbolId)?.source.file ?? '')
  }
  for (const relation of program.relationships) {
    const fromSymbol = symbols.get(relation.fromSymbolId)
    const toSymbol = symbols.get(relation.toSymbolId ?? '')
    const from = owners.get(fromSymbol?.source.file ?? '')
    const to = owners.get(toSymbol?.source.file ?? '')
    if (!from || !to || from === to || !fromSymbol || !toSymbol || relation.resolution === 'unresolved') continue
    const kind: DependencyKind = relation.kind === 'call' ? 'calls' : relation.kind === 'contract' ? 'contracts' :
      relation.kind.startsWith('field_') || relation.kind === 'shared_state' ? 'fields' : 'types'
    const id = edgeId(from, to, kind)
    let edge = edges.find((e) => e.id === id)
    if (!edge) {
      edge = { id, from, to, kind, weight: 0, verified: relation.resolution === 'resolved', confidence: relation.resolution === 'resolved' ? 1 : 0.5,
        evidence: [], origin: relation.origin, version: 1 }
      edges.push(edge)
    }
    edge.weight++
    edge.verified &&= relation.resolution === 'resolved'
    edge.evidence.push({ fromFile: fromSymbol.source.file, toFile: toSymbol.source.file,
      specifier: relation.targetName, symbols: [toSymbol.name], line: relation.source.line,
      relationshipId: relation.id, fromSymbolId: fromSymbol.id, toSymbolId: toSymbol.id,
      contractId: relation.contractId, resolution: relation.resolution })
  }
  const unresolved = program.relationships.filter((r) => r.resolution === 'unresolved')
  const warnings = [...graph.analysis.warnings,
    ...(unresolved.length ? [{ code: 'unresolved-symbols', message: `${unresolved.length} symbol references could not be bound; inspect their source-level relationships.` }] : []),
    ...(program.contracts.some((c) => c.verification === 'unverified') ? [{ code: 'unverified-contracts', message: 'Extracted contracts are specifications; no formal behavioral proof was performed.' }] : [])]
  return refreshComponents({ ...graph, program, edges, analysis: { ...graph.analysis, analyzerVersion: '2.0.0', warnings } })
}
