/**
 * The transformation engine.
 *
 * Takes the architecture as analyzed, a list of graph operations, and the
 * project's source files, and produces a `ChangeSet`: the exact set of file
 * creates, edits, moves and deletes that would implement those operations —
 * plus one honest outcome record per operation.
 *
 * Three rules shape the design:
 *
 *  1. Nothing is written. Planning is a pure function of (files, operations);
 *     `src/core/output/writer.ts` is the only code that touches disk.
 *  2. The graph is replayed in lockstep with the code. For operation *i* the
 *     executor sees the architecture as it was before *i* and after *i*, which
 *     is what lets a later operation refer to a module an earlier one created.
 *  3. An operation that cannot be carried out says so. `unsupported`,
 *     `partial` and `failed` are first-class outcomes, and a `ChangeSet` with
 *     no file changes is a perfectly valid — and clearly reported — result.
 */

import type { ArchitectureGraph } from '../../shared/types/architecture'
import type { ChangeSet, OperationOutcome } from '../../shared/types/generation'
import type { GraphOperation } from '../../shared/types/operations'
import { applyOperation } from '../../shared/graph/apply-operation'
import { diffArchitectures } from '../../shared/graph/diff'
import { findModule } from '../../shared/graph/model'
import { requiresAi } from '../../shared/types/operations'
import type { Logger } from '../logger'
import { silentLogger } from '../logger'
import {
  executeAddDependency,
  executeRemoveDependency
} from './ops/dependency-ops'
import {
  executeAddModule,
  executeDeleteModule,
  executeMoveFile,
  executeRenameModule
} from './ops/module-ops'
import { executeMoveSymbol } from './ops/move-symbol'
import {
  OPERATION_LABELS,
  failed,
  unsupported,
  type OpContext,
  type OpResult
} from './ops/context'
import { VirtualWorkspace } from './workspace'

/**
 * The hook the AI agent plugs into. Keeping it an interface means the engine
 * has no dependency on the Anthropic SDK, so every deterministic path is
 * testable with no API key and no network.
 */
export interface AiTransformer {
  readonly available: boolean
  /** Why the transformer is unavailable, for the user-facing message. */
  readonly unavailableReason: string
  execute(op: GraphOperation, ctx: OpContext): Promise<OpResult>
}

export interface PlanOptions {
  logger?: Logger
  ai?: AiTransformer | null
  signal?: AbortSignal
}

export interface PlanResult {
  changeSet: ChangeSet
  /** The architecture after replaying every operation. */
  graph: ArchitectureGraph
  workspace: VirtualWorkspace
}

function outcomeFrom(
  op: GraphOperation,
  result: OpResult
): OperationOutcome {
  return {
    operationId: op.id,
    operationType: op.type,
    status: result.status,
    message: result.message,
    executor: result.executor,
    touchedPaths: result.touchedPaths,
    warnings: result.warnings
  }
}

async function runOperation(
  op: GraphOperation,
  ctx: OpContext,
  ai: AiTransformer | null
): Promise<OpResult> {
  switch (op.type) {
    case 'add_module':
      return executeAddModule(op, ctx)
    case 'rename_module':
      return executeRenameModule(op, ctx)
    case 'move_file':
      return executeMoveFile(op, ctx)
    case 'delete_module':
      return executeDeleteModule(op, ctx)
    case 'move_symbol':
      return executeMoveSymbol(op, ctx)
    case 'add_dependency':
      return executeAddDependency(op, ctx)
    case 'remove_dependency':
      return executeRemoveDependency(op, ctx)
    case 'update_module':
      return {
        status: 'metadata_only',
        executor: 'none',
        message:
          'Updated the module description, responsibilities or interface in the graph. These are documentation, so no code changed.',
        touchedPaths: [],
        warnings: []
      }
    case 'move_responsibility':
    case 'scaffold_module': {
      if (!ai || !ai.available) {
        return unsupported(
          `${OPERATION_LABELS[op.type]} needs an AI model: it requires interpreting what the code means, not just where it lives. ${
            ai?.unavailableReason ?? 'No Anthropic API key is configured.'
          }`
        )
      }
      return ai.execute(op, ctx)
    }
    default: {
      const exhaustive: never = op
      return failed(`No executor for operation ${JSON.stringify(exhaustive)}`)
    }
  }
}

export async function planChanges(
  graph: ArchitectureGraph,
  operations: GraphOperation[],
  sourceFiles: Iterable<[string, string]>,
  options: PlanOptions = {}
): Promise<PlanResult> {
  const logger = options.logger ?? silentLogger
  const log = logger.child('generation')
  const ai = options.ai ?? null

  const workspace = new VirtualWorkspace(graph.projectRoot, sourceFiles)
  const startingGraph = graph
  let current = graph

  const outcomes: OperationOutcome[] = []
  const breakingChanges: string[] = []
  let aiSkipped = false

  log.info(
    `Planning ${operations.length} operation(s) against ${workspace.listFiles().length} source file(s)`
  )

  for (const [index, op] of operations.entries()) {
    if (options.signal?.aborted) {
      log.warn('Planning canceled')
      for (const remaining of operations.slice(index)) {
        outcomes.push({
          operationId: remaining.id,
          operationType: remaining.type,
          status: 'skipped',
          message: 'Canceled before this operation ran.',
          executor: 'none',
          touchedPaths: [],
          warnings: []
        })
      }
      break
    }

    const label = OPERATION_LABELS[op.type]
    const reduced = applyOperation(current, op)
    if (!reduced.ok) {
      log.error(`${label}: ${reduced.error}`)
      outcomes.push({
        operationId: op.id,
        operationType: op.type,
        status: 'failed',
        message: `The graph rejected this operation: ${reduced.error}`,
        executor: 'none',
        touchedPaths: [],
        warnings: []
      })
      continue
    }

    const ctx: OpContext = {
      workspace,
      graph: current,
      nextGraph: reduced.graph,
      log
    }

    let result: OpResult
    try {
      result = await runOperation(op, ctx, ai)
    } catch (error) {
      result = failed(
        `${label} threw while running: ${(error as Error).message}`
      )
    }

    if (result.status === 'unsupported' && requiresAi(op)) aiSkipped = true

    // The graph only advances when the operation did not fail outright, so a
    // failure cannot silently shift the architecture out from under later ops.
    if (result.status !== 'failed') current = reduced.graph

    for (const warning of result.warnings) log.warn(`${label}: ${warning}`)
    breakingChanges.push(...(result.breakingChanges ?? []))

    const level =
      result.status === 'applied'
        ? 'success'
        : result.status === 'failed'
          ? 'error'
          : 'warn'
    logger.log(level, 'generation', `${label}: ${result.message}`)

    outcomes.push(outcomeFrom(op, result))
  }

  const diff = diffArchitectures(startingGraph, current)
  const changes = workspace.changes()

  const changeSet: ChangeSet = {
    changes,
    outcomes,
    modulesAdded: diff.addedModules.map(
      (id) => findModule(current, id)?.name ?? id
    ),
    modulesRemoved: diff.removedModules.map(
      (id) => findModule(startingGraph, id)?.name ?? id
    ),
    modulesRenamed: diff.renamedModules.map((r) => ({ from: r.from, to: r.to })),
    breakingChanges: [...new Set(breakingChanges)],
    aiSkipped
  }

  const created = changes.filter((c) => c.kind === 'create').length
  const modified = changes.filter((c) => c.kind === 'modify').length
  const renamed = changes.filter((c) => c.kind === 'rename').length
  const deleted = changes.filter((c) => c.kind === 'delete').length

  if (changes.length === 0) {
    log.warn(
      'No file changes were produced. Either the operations were metadata-only, or none of them could be carried out — see the outcomes above.'
    )
  } else {
    log.success(
      `Plan ready: ${created} created, ${modified} modified, ${renamed} moved, ${deleted} deleted`
    )
  }

  return { changeSet, graph: current, workspace }
}

/** Counts of each outcome status, for the results panel. */
export function summarizeOutcomes(
  changeSet: ChangeSet
): Record<OperationOutcome['status'], number> {
  const counts: Record<OperationOutcome['status'], number> = {
    applied: 0,
    metadata_only: 0,
    partial: 0,
    unsupported: 0,
    failed: 0,
    skipped: 0
  }
  for (const outcome of changeSet.outcomes) counts[outcome.status] += 1
  return counts
}
