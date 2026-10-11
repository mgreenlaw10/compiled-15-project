import type { ArchitectureGraph } from '../types/architecture'
import type { GraphOperationBody } from '../types/operations'
import type { ApplyOperationResult } from './apply-operation'
import { refreshComponents, stableId } from './program'
import { createEdge } from './model'

export function applyProgramOperation(graph: ArchitectureGraph, op: GraphOperationBody): ApplyOperationResult | null {
  if (!['update_symbol', 'add_symbol', 'remove_symbol', 'update_implementation', 'add_contract', 'modify_contract', 'remove_contract', 'add_contract_dependency'].includes(op.type)) return null
  if (!('moduleId' in op)) return { ok: false, error: 'Module ID required.' }
  const module = graph.modules.find((m) => m.id === op.moduleId)
  if (!module) return { ok: false, error: `Module not found: ${op.moduleId}` }
  let program = graph.program
  let modules = graph.modules
  let edges = graph.edges
  const ownSymbol = (id: string): boolean => program.symbols.some((s) => s.id === id && module.files.includes(s.source.file))
  const ownField = (symbolId: string | undefined, fieldId: string | undefined): boolean => !fieldId ||
    program.symbols.some((s) => s.id === symbolId && ownSymbol(s.id) && s.fields.some((f) => f.id === fieldId))
  const invalid = (error: string): ApplyOperationResult => ({ ok: false, error })
  switch (op.type) {
    case 'update_symbol':
    case 'remove_symbol': {
      const symbol = program.symbols.find((s) => s.id === op.symbolId)
      if (!symbol || !ownSymbol(op.symbolId)) return invalid('Symbol does not belong to the selected module.')
      if (op.expectedVersion !== undefined && op.expectedVersion !== symbol.version) return invalid('Symbol version conflict; reload the observed properties before editing.')
      if (op.type === 'update_symbol' && op.changes.name && !/^[A-Za-z_$][\w$]*$/.test(op.changes.name)) return invalid('Invalid symbol name.')
      program = { ...program, symbols: op.type === 'remove_symbol' ? program.symbols.filter((s) => s.id !== op.symbolId) :
        program.symbols.map((s) => s.id !== op.symbolId ? s : { ...s, ...op.changes,
          qualifiedName: op.changes.name ? [...s.qualifiedName.split('.').slice(0, -1), op.changes.name].join('.') : s.qualifiedName,
          publiclyAccessible: op.changes.accessibility ? op.changes.accessibility === 'public' : s.publiclyAccessible,
          descriptionOrigin: op.changes.description !== undefined ? 'user' : s.descriptionOrigin, version: s.version + 1 }) }
      if (op.type === 'update_symbol' && op.changes.name && symbol.language === 'java' && !symbol.scope &&
        !symbol.sourceText && !symbol.definition &&
        (symbol.source.file.endsWith(`/${symbol.name}.java`) || symbol.source.file === `${symbol.name}.java`)) {
        const name = op.type === 'update_symbol' ? op.changes.name! : symbol.name
        const nextFile = symbol.source.file.slice(0, -`${symbol.name}.java`.length) + `${name}.java`
        if (graph.modules.some((m) => m.id !== module.id && m.files.includes(nextFile)) || module.files.some((f) => f === nextFile && f !== symbol.source.file)) return invalid('The renamed type would conflict with an existing source file.')
        modules = modules.map((m) => m.id === module.id ? { ...m, files: m.files.map((f) => f === symbol.source.file ? nextFile : f) } : m)
        program = { ...program, symbols: program.symbols.map((s) => s.id === symbol.id ? { ...s,
          source: { ...s.source, file: nextFile }, nameSource: { ...s.nameSource, file: nextFile }, signatureSource: { ...s.signatureSource, file: nextFile },
          fields: s.fields.map((f) => ({ ...f, source: { ...f.source, file: nextFile } })) } : s) }
      }
      break
    }
    case 'add_symbol':
      if (program.symbols.some((s) => s.id === op.symbol.id)) return invalid('Symbol ID already exists.')
      if (!module.files.includes(op.symbol.source.file)) {
        if (graph.modules.some((m) => m.id !== module.id && m.files.includes(op.symbol.source.file))) return invalid('The planned file already belongs to another module.')
        if (op.symbol.sourceText || op.symbol.definition || op.symbol.source.start !== 0 || op.symbol.source.end !== 0 ||
          !op.symbol.source.file || /(^|\/)\.\.(\/|$)|^\/|^[A-Za-z]:|\\/.test(op.symbol.source.file)) return invalid('Choose a file owned by this module.')
        modules = modules.map((m) => m.id === module.id ? { ...m, files: [...m.files, op.symbol.source.file] } : m)
      }
      program = { ...program, symbols: [...program.symbols, { ...op.symbol, version: 1 }] }; break
    case 'update_implementation':
      modules = modules.map((m) => m.id === module.id ? { ...m, components: { ...m.components,
        implementation: { ...m.components.implementation, desiredDescription: op.description } } } : m); break
    case 'add_contract':
      if (program.contracts.some((c) => c.id === op.contract.id)) return invalid('Contract ID already exists.')
      if (op.contract.symbolId && !ownSymbol(op.contract.symbolId)) return invalid('Contract target does not belong to this module.')
      if (!ownField(op.contract.symbolId, op.contract.fieldId)) return invalid('Contract field does not belong to the target data structure.')
      program = { ...program, contracts: [...program.contracts, { ...op.contract, moduleId: module.id, provenance: 'user_specified',
        verification: 'unverified', verificationNote: 'Desired behavior specified by the user; not yet established in code.', version: 1 }] }; break
    case 'modify_contract':
    case 'remove_contract': {
      const contract = program.contracts.find((c) => c.id === op.contractId)
      if (!contract || !module.components.contracts.contractIds.includes(contract.id)) return invalid('Contract not found in this module.')
      if (op.expectedVersion !== undefined && op.expectedVersion !== contract.version) return invalid('Contract version conflict; inspect the current specification first.')
      if (op.type === 'modify_contract' && op.changes.symbolId && !ownSymbol(op.changes.symbolId)) return invalid('Contract target does not belong to this module.')
      if (op.type === 'modify_contract' && !ownField(op.changes.symbolId ?? contract.symbolId, op.changes.fieldId ?? contract.fieldId)) return invalid('Contract field does not belong to the target data structure.')
      program = { ...program, contracts: op.type === 'remove_contract' ? program.contracts.filter((c) => c.id !== contract.id) :
        program.contracts.map((c) => c.id === contract.id ? { ...c, ...op.changes, provenance: 'user_specified', verification: 'unverified',
          verificationNote: 'Pending behavioral change. Compilation alone cannot establish this guarantee.', version: c.version + 1 } : c) }; break
    }
    case 'add_contract_dependency': {
      const contract = program.contracts.find((c) => c.id === op.contractId)
      const from = program.symbols.find((s) => s.id === op.fromSymbolId)
      if (!contract || !from || !ownSymbol(from.id)) return invalid('Contract or consuming symbol not found.')
      const id = stableId('relationship', `${from.id}:contract:${contract.id}`)
      if (program.relationships.some((r) => r.id === id)) return invalid('This reliance is already recorded.')
      program = { ...program, relationships: [...program.relationships, { id, kind: 'contract', fromSymbolId: from.id,
        toSymbolId: contract.symbolId, contractId: contract.id, targetName: contract.description, source: from.source,
        resolution: 'potential', origin: 'user', assumptions: ['User-declared reliance; no consuming source evidence establishes it.'], conditional: false, version: 1 }] }
      if (contract.moduleId && contract.moduleId !== module.id) {
        const edge = edges.find((e) => e.from === module.id && e.to === contract.moduleId && e.kind === 'contracts') ??
          createEdge({ from: module.id, to: contract.moduleId, kind: 'contracts', origin: 'user', verified: false })
        const updated = { ...edge, verified: false, confidence: Math.min(edge.confidence, 0.5), weight: edge.evidence.length + 1, evidence: [...edge.evidence, { fromFile: from.source.file,
          toFile: program.symbols.find((s) => s.id === contract.symbolId)?.source.file ?? '', line: from.source.line,
          symbols: [from.name], specifier: 'user-declared contract reliance', relationshipId: id, fromSymbolId: from.id, toSymbolId: contract.symbolId, contractId: contract.id,
          resolution: 'potential' as const }] }
        edges = [...edges.filter((e) => e.id !== edge.id), updated]
      }
      break
    }
    default: return null
  }
  modules = modules.map((m) => m.id === module.id ? { ...m, version: m.version + 1 } : m)
  return { ok: true, graph: refreshComponents({ ...graph, modules, edges, program, version: graph.version + 1 }), warnings: [] }
}
