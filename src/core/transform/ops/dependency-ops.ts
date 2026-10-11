/**
 * Dependency edges.
 *
 * These two operations are where it matters most that Cartograph does not
 * overstate what it did:
 *
 *   - Adding a dependency is a statement of intent. There is no honest
 *     deterministic transformation that makes module A "use" module B, so the
 *     edge is recorded in the architecture and the operation reports itself as
 *     metadata-only.
 *   - Removing a dependency that real imports back up *does* require code
 *     changes, and guessing at them would be worse than refusing. The executor
 *     therefore lists the exact imports that stand in the way and reports
 *     `unsupported`, leaving the work to the AI agent or to the user.
 */

import type {
  AddDependencyOperation,
  GraphOperation,
  RemoveDependencyOperation
} from '../../../shared/types/operations'
import { findEdge, findModule } from '../../../shared/graph/model'
import { metadataOnly, type OpContext, type OpResult, unsupported } from './context'

export function executeAddDependency(
  op: AddDependencyOperation & GraphOperation,
  ctx: OpContext
): OpResult {
  const from = findModule(ctx.nextGraph, op.from)
  const to = findModule(ctx.nextGraph, op.to)
  const label = `${from?.name ?? op.from} -> ${to?.name ?? op.to}`

  const existing = findEdge(ctx.graph, op.from, op.to)
  if (existing?.verified) {
    return metadataOnly(
      `${label} was already backed by ${existing.weight} real import(s); the edge kind is now "${op.kind}". No code changed.`
    )
  }

  return metadataOnly(
    `Recorded the intended dependency ${label} in the architecture. No source code was written: nothing can make one module use another without deciding what it should call. Use "Generate implementation" on ${to?.name ?? op.to}, or write the first import by hand.`
  )
}

export function executeRemoveDependency(
  op: RemoveDependencyOperation & GraphOperation,
  ctx: OpContext
): OpResult {
  const from = findModule(ctx.graph, op.from)
  const to = findModule(ctx.graph, op.to)
  const label = `${from?.name ?? op.from} -> ${to?.name ?? op.to}`
  const edge = findEdge(ctx.graph, op.from, op.to)

  if (!edge || !edge.verified || edge.evidence.length === 0) {
    return metadataOnly(
      `Removed the declared dependency ${label} from the architecture. It was not backed by any imports, so no code needed to change.`
    )
  }

  const offenders = edge.evidence
    .slice(0, 12)
    .map((e) => `${e.fromFile}:${e.line} imports ${e.symbols.join(', ')} from "${e.specifier}"`)
  const more =
    edge.evidence.length > offenders.length
      ? [`…and ${edge.evidence.length - offenders.length} more import(s).`]
      : []

  return unsupported(
    `Cannot remove ${label} automatically: ${edge.weight} real import(s) still connect these modules. Severing a dependency means deciding what replaces it — an interface, an injected parameter, a move — which this engine will not guess.`,
    {
      warnings: [
        'The edge was removed from the graph but the imports remain. The graph and the code now disagree until you change one of them.'
      ],
      breakingChanges: [...offenders, ...more]
    }
  )
}
