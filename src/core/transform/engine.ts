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
import { applyOperation, projectedMoveTarget } from '../../shared/graph/apply-operation'
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
import { executeProgramOperation } from './ops/program-ops'
import { analyzeImpact } from '../../shared/graph/impact'
import { refreshProgramAnchors } from './program-anchors'
import { prepareDraftOperations } from './draft-operations'

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
  const languageMove = async (): Promise<OpResult> => ai?.available ? ai.execute(op, ctx) :
    unsupported('Moving these files requires language-specific import/include and ownership changes. Enable AI assistance, or refactor the source and reanalyze.')
  const isJsTs = (file: string): boolean => /\.[cm]?[jt]sx?$/i.test(file)
  switch (op.type) {
    case 'update_symbol': case 'remove_symbol': case 'add_contract': case 'modify_contract': case 'remove_contract':
    case 'add_contract_dependency': {
      const result = executeProgramOperation(op, ctx)
      if ((result.status === 'unsupported' || result.status === 'partial') && ai?.available && op.type !== 'add_contract_dependency') {
        const assisted = await ai.execute(op, ctx)
        return { ...assisted, touchedPaths: [...new Set([...result.touchedPaths, ...assisted.touchedPaths])],
          warnings: [...result.warnings, ...assisted.warnings],
          status: result.touchedPaths.length && assisted.status === 'unsupported' ? 'partial' : assisted.status }
      }
      return result
    }
    case 'add_symbol':
      if (!op.symbol.description.trim() && !op.symbol.signature.trim() && !op.symbol.fields.length) {
        return unsupported('Describe what the new symbol should do in its properties before generating. A signature is optional.')
      }
      if (ai?.available) return ai.execute(op, ctx)
      return unsupported(`This operation needs an AI model to implement the requested behavior. ${ai?.unavailableReason ?? 'No model provider API key is configured.'}`)
    case 'update_implementation':
      if (ai?.available) return ai.execute(op, ctx)
      return unsupported(`This operation needs an AI model to implement the requested behavior. ${ai?.unavailableReason ?? 'No model provider API key is configured.'}`)
    case 'add_module':
      return executeAddModule(op, ctx)
    case 'rename_module':
      if (op.directory && op.directory !== findModule(ctx.graph, op.moduleId)?.directory &&
        findModule(ctx.graph, op.moduleId)?.files.some((file) => !isJsTs(file))) return languageMove()
      return executeRenameModule(op, ctx)
    case 'move_file': {
      const destination = findModule(ctx.nextGraph, op.toModuleId)
      if (!isJsTs(op.file) && destination && projectedMoveTarget(op.file, destination, op.toPath) !== op.file) return languageMove()
      return executeMoveFile(op, ctx)
    }
    case 'delete_module': {
      const destination = op.reassignTo ? findModule(ctx.nextGraph, op.reassignTo) : undefined
      if (op.fileDisposition === 'reassign' && destination && findModule(ctx.graph, op.moduleId)?.files.some((file) =>
        !isJsTs(file) && projectedMoveTarget(file, destination) !== file)) return languageMove()
      return executeDeleteModule(op, ctx)
    }
    case 'move_symbol':
      if (!/\.[cm]?[jt]sx?$/i.test(op.fromFile)) {
        if (ai?.available) return ai.execute(op, ctx)
        return unsupported('Moving this scoped symbol requires language-specific caller and ownership changes. Enable AI assistance, or refactor the source and reanalyze.')
      }
      return executeMoveSymbol(op, ctx)
    case 'add_dependency':
    case 'remove_dependency': {
      const result = op.type === 'add_dependency' ? executeAddDependency(op, ctx) : executeRemoveDependency(op, ctx)
      if (['unsupported', 'partial', 'failed'].includes(result.status) && ai?.available) return ai.execute(op, ctx)
      return result
    }
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
  const prepared = prepareDraftOperations(graph, operations)
  const creationResults = new Map<string, OpResult>()
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
    breakingChanges.push(...analyzeImpact(startingGraph, op).map((impact) =>
      `${startingGraph.modules.find((m) => m.id === impact.moduleId)?.name ?? impact.moduleId}: ${impact.reason}`))
    const effective = prepared.creations.get(op.id) ?? op
    const reduced = applyOperation(current, effective)
    if (!reduced.ok) {
      // A stale local projection is context for generation, not a veto on
      // user intent. Let the transformer resolve source ownership/dependencies.
      log.warn(`${label}: resolving graph mismatch through generation: ${reduced.error}`)
      let result: OpResult
      try {
        result = ai?.available ? await ai.execute(effective, {
          workspace, graph: current, nextGraph: current, log
        }) : unsupported(`Enable AI assistance to reconcile this edit with the current source. ${ai?.unavailableReason ?? 'No model provider API key is configured.'}`)
      } catch (error) {
        result = failed(`${label} threw while running: ${(error as Error).message}`)
      }
      if (result.touchedPaths.length && ['applied', 'partial'].includes(result.status)) {
        try { current = await refreshProgramAnchors(current, workspace) }
        catch (error) { result.warnings.push(`Could not refresh source bindings: ${(error as Error).message}`) }
      }
      outcomes.push(outcomeFrom(op, result))
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
      const creationId = prepared.includedEdits.get(op.id)
      const creation = creationId ? creationResults.get(creationId) : undefined
      if (creation) {
        result = { ...creation, message: `These properties were included in the new symbol's generation. ${creation.message}` }
        for (const path of creation.touchedPaths) {
          const content = workspace.read(path)
          if (content !== null) workspace.write(path, content, { operationId: op.id, reason: 'Include new symbol properties' })
        }
      } else result = await runOperation(effective, ctx, ai)
    } catch (error) {
      result = failed(
        `${label} threw while running: ${(error as Error).message}`
      )
    }

    if (result.status === 'unsupported' && requiresAi(op)) aiSkipped = true

    // The graph only advances when the operation did not fail outright, so a
    // failure cannot silently shift the architecture out from under later ops.
    if (result.status !== 'failed') current = reduced.graph
    if (['applied', 'partial'].includes(result.status) && result.touchedPaths.length && current.program.symbols.length) {
      try { current = await refreshProgramAnchors(current, workspace) }
      catch (error) {
        result.status = 'partial'
        result.warnings.push(`Could not refresh source bindings after this edit: ${(error as Error).message}. Reanalyze before applying further component edits.`)
      }
    }
    if (op.type === 'add_symbol') creationResults.set(op.id, result)

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
