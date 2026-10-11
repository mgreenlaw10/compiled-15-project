/**
 * The architecture itself, and the operation log that connects the two graphs.
 *
 * `dispatchOperation` is the only way the UI changes the architecture. It runs
 * the same pure reducer the backend does (`shared/graph/apply-operation.ts`),
 * so the preview the user sees and the plan the engine builds come from one
 * implementation — and so a rejected edit is rejected identically in both.
 *
 * Every operation is stamped with the actor from the session slice and the
 * graph version it was authored against. Those two fields are what a
 * multi-writer merge needs; see `shared/collab/session.ts`.
 */

import { applyOperation } from '../../../shared/graph/apply-operation'
import { fillMissingPositions } from '../../../shared/graph/layout'
import {
  isStructural,
  type GraphOperation,
  type GraphOperationBody
} from '../../../shared/types/operations'
import { operationId } from '../../../shared/util/id'
import type { GraphSlice, Slice } from '../types'
import { MAX_LOGS, uiLog } from './logs'

/** One line of activity-log text per operation kind. */
export function describeOperation(body: GraphOperationBody): string {
  switch (body.type) {
    case 'add_module':
      return `created module "${body.module.name}"`
    case 'rename_module':
      return `renamed a module to "${body.name}"`
    case 'update_module':
      return 'edited module properties'
    case 'delete_module':
      return `deleted a module (${body.fileDisposition} its files)`
    case 'move_file':
      return `moved ${body.file}`
    case 'move_symbol':
      return `moved symbol ${body.symbol}`
    case 'move_responsibility':
      return `moved responsibility "${body.responsibility}"`
    case 'add_dependency':
      return `added a ${body.kind} dependency`
    case 'remove_dependency':
      return 'removed a dependency'
    case 'scaffold_module':
      return 'requested an implementation for a module'
    default:
      return 'edited the architecture'
  }
}

export const createGraphSlice: Slice<GraphSlice> = (set, get) => ({
  original: null,
  desired: null,
  operations: [],
  appliedOperationIds: [],

  dispatchOperation(body) {
    const { desired, operations, layout, actor } = get()
    if (!desired) return false

    const result = applyOperation(desired, body)
    if (!result.ok) {
      set((state) => ({
        error: result.error,
        logs: [...state.logs, uiLog('error', 'app', result.error)].slice(-MAX_LOGS)
      }))
      return false
    }

    const op: GraphOperation = {
      ...body,
      id: operationId(),
      actor: actor.id,
      issuedAt: new Date().toISOString(),
      baseVersion: desired.version
    } as GraphOperation

    const nextLogs = [
      ...get().logs,
      uiLog(
        isStructural(op) ? 'info' : 'debug',
        'app',
        `${isStructural(op) ? 'Structural' : 'Metadata'} edit: ${describeOperation(body)}`
      ),
      ...result.warnings.map((w) => uiLog('warn', 'app', w))
    ].slice(-MAX_LOGS)

    set({
      desired: result.graph,
      operations: [...operations, op],
      layout: {
        ...layout,
        positions: fillMissingPositions(result.graph, layout.positions),
        version: layout.version + 1
      },
      dirty: true,
      error: null,
      logs: nextLogs,
      // A new plan has to be built after any edit.
      changeSet: null,
      diffs: null,
      ...(body.type === 'add_module' ? { selectedModuleId: body.module.id } : {}),
      ...(body.type === 'delete_module' && get().selectedModuleId === body.moduleId
        ? { selectedModuleId: null }
        : {})
    })
    return true
  }
})
