import type { ArchitectureGraph } from '../types/architecture'
import type { GraphOperationBody } from '../types/operations'
import type { Impact } from '../types/program'

/** Always consult observed relationships: deleting desired elements must not erase impact. */
export function analyzeImpact(observed: ArchitectureGraph, operation: GraphOperationBody): Impact[] {
  const symbolId = 'symbolId' in operation ? operation.symbolId : undefined
  const contractId = operation.type === 'add_contract' ? operation.contract.id : 'contractId' in operation ? operation.contractId : undefined
  const contract = operation.type === 'add_contract' ? operation.contract : observed.program.contracts.find((c) => c.id === contractId)
  const targetId = symbolId ?? contract?.symbolId
  const impacts: Impact[] = []
  const owner = (id: string): string | undefined => {
    const file = observed.program.symbols.find((s) => s.id === id)?.source.file
    return observed.modules.find((m) => file && m.files.includes(file))?.id
  }
  const contractEdit = ['add_contract', 'modify_contract', 'remove_contract'].includes(operation.type)
  const changedFields = operation.type === 'update_symbol' && operation.changes.fields ?
    observed.program.symbols.find((s) => s.id === targetId)?.fields.filter((f) => {
      const next = operation.changes.fields!.find((n) => n.id === f.id)
      return !next || next.name !== f.name || next.type !== f.type || next.accessibility !== f.accessibility
    }) ?? [] : []
  for (const relation of observed.program.relationships) {
    const matches = contractEdit ? relation.contractId === contractId || (contract?.fieldId ? relation.toFieldId === contract.fieldId : !!targetId && relation.toSymbolId === targetId) :
      !!targetId && relation.toSymbolId === targetId
    if (!matches) continue
    if (operation.type === 'update_symbol' && operation.changes.fields && relation.toFieldId && !changedFields.some((f) => f.id === relation.toFieldId)) continue
    const moduleId = owner(relation.fromSymbolId)
    if (!moduleId) continue
    const explicitReliance = relation.contractId === contractId && relation.resolution === 'resolved' && relation.origin === 'static'
    impacts.push({ moduleId, symbolId: relation.fromSymbolId, ...(contractId ? { contractId } : {}),
      severity: contractEdit ? 'potential' : relation.resolution === 'resolved' ? 'breaking' : 'potential',
      reason: contractEdit ? explicitReliance ? 'Explicitly documented reliance on the edited contract; behavioral compatibility must be checked.' :
        `${relation.kind === 'call' ? 'Calls' : 'Uses'} the provider of the edited contract; reliance on this guarantee is potential, not confirmed.` :
        `${relation.kind} depends on ${relation.toFieldId ? `the edited field ${changedFields.find((f) => f.id === relation.toFieldId)?.name ?? relation.targetName}` : 'the edited symbol'}${relation.conditional ? ' in a conditional branch' : ''}.`, evidence: [relation.source] })
  }
  if (contractEdit && !targetId && contract?.moduleId) {
    for (const edge of observed.edges.filter((e) => e.to === contract.moduleId)) {
      if (impacts.some((i) => i.moduleId === edge.from)) continue
      impacts.push({ moduleId: edge.from, contractId, severity: 'potential',
        reason: 'Depends on the module whose behavioral specification changed; reliance on this module-wide guarantee is potential.',
        evidence: observed.program.relationships.filter((r) => edge.evidence.some((e) => e.relationshipId === r.id)).map((r) => r.source) })
    }
  }
  if (contractEdit) impacts.push({ moduleId: 'moduleId' in operation ? operation.moduleId : contract?.moduleId ?? '', contractId,
    severity: 'unverified', reason: 'The changed behavioral guarantee requires verification beyond compilation.', evidence: contract?.evidence ?? [] })
  return impacts
}
