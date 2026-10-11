import type { ArchitectureGraph } from '../../shared/types/architecture'
import type { GraphOperation } from '../../shared/types/operations'
import { applyOperation } from '../../shared/graph/apply-operation'

/** Create a new element once, using its immediately following property edits. */
export function prepareDraftOperations(graph: ArchitectureGraph, operations: GraphOperation[]): {
  creations: Map<string, GraphOperation>; includedEdits: Map<string, string>
} {
  const creations = new Map<string, GraphOperation>()
  const includedEdits = new Map<string, string>()
  let preview = graph
  for (let index = 0; index < operations.length; index++) {
    const op = operations[index]
    const reduced = applyOperation(preview, op)
    if (!reduced.ok) continue
    preview = reduced.graph
    if (op.type !== 'add_symbol' || op.symbol.sourceText || op.symbol.definition) continue
    let desired = op.symbol
    for (let next = index + 1; next < operations.length; next++) {
      const edit = operations[next]
      if (edit.type !== 'update_symbol' || edit.symbolId !== op.symbol.id) break
      const updated = applyOperation(preview, edit)
      if (!updated.ok) break
      preview = updated.graph
      desired = preview.program.symbols.find((s) => s.id === op.symbol.id)!
      includedEdits.set(edit.id, op.id)
      index = next
    }
    creations.set(op.id, { ...op, symbol: { ...desired, version: 1 } })
  }
  return { creations, includedEdits }
}
