/**
 * The AI transformer: the bridge between the transformation engine and the
 * agent.
 *
 * The engine knows nothing about any model SDK; it only knows the
 * `AiTransformer` interface. This module implements it, which keeps every
 * deterministic code path free of any dependency on a model, a key, or a
 * network — and makes the whole engine testable with a fake transformer.
 *
 * It also translates the agent's self-reported status into an operation
 * outcome, and it does not take that report at face value: a model that claims
 * success while changing nothing is downgraded, because the one thing this
 * application must never do is tell a user their architecture change is done
 * when the code is untouched.
 */

import type { GraphOperation } from '../../shared/types/operations'
import type { AiTransformer } from '../transform/engine'
import type { OpContext, OpResult } from '../transform/ops/context'
import type { Logger } from '../logger'
import { runAgent, type AgentOutcome, type RunAgentOptions } from './agent'
import { createAiClient, isConfigured } from './client'
import type { AiConfig } from '../../shared/ai'
import { moveResponsibilityPrompt, scaffoldModulePrompt } from './prompts'

export interface AiTransformerDeps {
  config: AiConfig | null
  logger: Logger
  signal?: AbortSignal
  /**
   * The agent runner. Injectable so the outcome-checking below — the part that
   * decides whether to believe the model — can be tested without a network
   * call or an API key.
   */
  runner?: (options: RunAgentOptions) => Promise<AgentOutcome>
}

export function createAiTransformer(deps: AiTransformerDeps): AiTransformer {
  const available = isConfigured(deps.config)

  return {
    available,
    unavailableReason: available
      ? ''
      : 'Add a model provider API key in Settings to enable AI-assisted transformations.',

    async execute(op: GraphOperation, ctx: OpContext): Promise<OpResult> {
      if (!deps.config || !available) {
        return {
          status: 'unsupported',
          executor: 'none',
          message:
            'No model provider API key is configured, so this operation was not attempted.',
          touchedPaths: [],
          warnings: []
        }
      }

      const log = deps.logger.child('ai')
      const client = createAiClient(deps.config)

      let task: string
      if (op.type === 'move_responsibility') {
        task = moveResponsibilityPrompt(op, ctx.nextGraph)
        log.info(
          `Moving responsibility "${op.responsibility}" from ${op.fromModuleId} to ${op.toModuleId}`
        )
      } else if (op.type === 'scaffold_module') {
        task = scaffoldModulePrompt(op, ctx.nextGraph)
        log.info(`Generating an implementation for module ${op.moduleId}`)
      } else {
        return {
          status: 'unsupported',
          executor: 'ai',
          message: `The AI transformer does not handle "${op.type}" operations.`,
          touchedPaths: [],
          warnings: []
        }
      }

      const run = deps.runner ?? runAgent
      const outcome = await run({
        client,
        operation: op,
        task,
        toolContext: {
          workspace: ctx.workspace,
          graph: ctx.graph,
          nextGraph: ctx.nextGraph,
          log
        },
        log,
        signal: deps.signal
      })

      const touched = outcome.touchedPaths
      const warnings = [...(outcome.report?.warnings ?? [])]

      if (!outcome.report) {
        return {
          status: touched.length > 0 ? 'partial' : 'failed',
          executor: 'ai',
          message:
            outcome.stoppedBecause ??
            'The agent stopped without reporting what it did.',
          touchedPaths: touched,
          warnings: [
            ...warnings,
            touched.length > 0
              ? `${touched.length} file(s) were changed before the agent stopped. Review them closely before applying.`
              : 'No files were changed.'
          ]
        }
      }

      // The report is a claim. Cross-check it against what actually changed.
      let status = outcome.report.status as OpResult['status']
      let message = outcome.report.summary

      if (outcome.report.status === 'applied' && touched.length === 0) {
        status = 'unsupported'
        message = `The agent reported success but changed no files, so nothing was applied. It said: "${outcome.report.summary}"`
        warnings.push(
          'The model\'s claim did not match the change set, so the outcome was downgraded.'
        )
      } else if (outcome.report.status === 'unsupported' && touched.length > 0) {
        status = 'partial'
        message = `The agent reported it could not finish, but changed ${touched.length} file(s): "${outcome.report.summary}"`
        warnings.push(
          'Review these changes carefully: the model itself did not consider the task complete.'
        )
      }

      if (outcome.stoppedBecause) {
        warnings.push(outcome.stoppedBecause)
      }

      return {
        status,
        executor: 'ai',
        message: `${message} (${outcome.turns} turn(s), ${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out tokens)`,
        touchedPaths: touched,
        warnings,
        breakingChanges: []
      }
    }
  }
}

/** A transformer that is always unavailable, for runs with AI turned off. */
export const disabledAiTransformer: AiTransformer = {
  available: false,
  unavailableReason: 'AI assistance was turned off for this run.',
  async execute() {
    return {
      status: 'unsupported',
      executor: 'none',
      message: 'AI assistance was turned off for this run.',
      touchedPaths: [],
      warnings: []
    }
  }
}
