/**
 * The agent loop.
 *
 * A hand-written loop rather than the SDK's tool runner, because every turn has
 * to be reported to the GUI's activity panel, the loop has to be cancellable
 * mid-task, and the tools need the virtual workspace threaded through them.
 *
 * Requests stream (tool inputs here include whole file contents, which is
 * exactly the case streaming exists for), thinking is adaptive, and because
 * eager input streaming means the server stops validating tool inputs, every
 * input is re-validated client-side in `runTool` before it runs.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { APIError } from '@anthropic-ai/sdk'

import type { GraphOperation } from '../../shared/types/operations'
import type { ChannelLogger } from '../logger'
import { describeApiError, type AiClient } from './client'
import { SYSTEM_PROMPT } from './prompts'
import {
  createToolRunState,
  runTool,
  toolDefinitions,
  type ToolRunContext,
  type ToolRunState
} from './tools'

/** Stops a runaway loop. Each turn is one model call plus its tool calls. */
const MAX_TURNS = 30
const MAX_TOKENS = 64_000
const MAX_JSON_RETRIES = 2

/** Server-side refusal fallbacks: routes by refusal category automatically. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export interface AgentOutcome {
  /** What the model said it achieved, via `report_result`. */
  report: ToolRunState['finalReport']
  touchedPaths: string[]
  turns: number
  /** Set when the loop ended for a reason other than a clean report. */
  stoppedBecause: string | null
  usage: { inputTokens: number; outputTokens: number }
}

export interface RunAgentOptions {
  client: AiClient
  operation: GraphOperation
  task: string
  toolContext: Omit<ToolRunContext, 'operation' | 'maxFileReads'>
  log: ChannelLogger
  signal?: AbortSignal
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** `true` when the API rejected the request because of the fallbacks beta. */
function isFallbackRejection(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status !== 400) return false
  const message = error.message.toLowerCase()
  return message.includes('fallback') || message.includes('beta')
}

export async function runAgent(options: RunAgentOptions): Promise<AgentOutcome> {
  const { client, log, operation } = options
  const tools = toolDefinitions()
  const state = createToolRunState()
  const toolContext: ToolRunContext = {
    ...options.toolContext,
    operation,
    maxFileReads: client.maxFileReads
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: 'user', content: options.task }
  ]

  let turns = 0
  let jsonRetries = 0
  let useFallbacks = true
  let stoppedBecause: string | null = null
  const usage = { inputTokens: 0, outputTokens: 0 }

  log.info(`Starting ${client.model} at effort "${client.effort}"`)

  while (turns < MAX_TURNS) {
    if (options.signal?.aborted) {
      stoppedBecause = 'Canceled by the user.'
      break
    }
    turns += 1

    let message: Anthropic.Beta.BetaMessage
    try {
      const stream = client.sdk.beta.messages.stream({
        model: client.model,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            // The system prompt and tool list are identical every turn, so the
            // whole prefix is cached and only the growing tail is re-read.
            cache_control: { type: 'ephemeral' }
          }
        ],
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: client.effort },
        tools,
        messages,
        ...(useFallbacks
          ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const }
          : {})
      })

      stream.on('text', (delta) => {
        if (delta.trim() !== '') log.debug(delta.trim())
      })

      message = await stream.finalMessage()
      jsonRetries = 0
    } catch (error) {
      if (useFallbacks && isFallbackRejection(error)) {
        // The deployment does not accept the fallbacks beta; carry on without
        // it rather than failing the user's refactor over a resilience extra.
        log.debug('Server-side refusal fallbacks are unavailable here; continuing without them.')
        useFallbacks = false
        turns -= 1
        continue
      }
      if (!(error instanceof APIError) && jsonRetries < MAX_JSON_RETRIES) {
        // A tool input that could not be parsed at all: re-issue the turn.
        jsonRetries += 1
        log.warn('A tool call arrived unparseable; asking the model to repeat the turn.')
        turns -= 1
        continue
      }
      stoppedBecause = describeApiError(error)
      log.error('The model call failed', stoppedBecause)
      break
    }

    usage.inputTokens += message.usage.input_tokens
    usage.outputTokens += message.usage.output_tokens

    for (const block of message.content) {
      if (block.type === 'thinking' && block.thinking.trim() !== '') {
        log.debug(`thinking: ${block.thinking.trim()}`)
      }
    }
    const said = textOf(message)
    if (said !== '') log.info(said)

    if (message.stop_reason === 'refusal') {
      stoppedBecause = `The model declined this request${
        message.stop_details && 'category' in message.stop_details
          ? ` (${String(message.stop_details.category)})`
          : ''
      }. No tools from that turn were run.`
      log.warn(stoppedBecause)
      break
    }

    if (message.stop_reason === 'max_tokens') {
      stoppedBecause =
        'The model hit its output limit mid-turn, so the turn was discarded rather than half-applied.'
      log.warn(stoppedBecause)
      break
    }

    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content })
      continue
    }

    const toolUses = message.content.filter(
      (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use'
    )

    if (toolUses.length === 0) {
      // `end_turn` with no tool call: the model is done talking but never
      // reported. Ask once, then give up rather than looping.
      if (state.finalReport) break
      if (turns >= MAX_TURNS - 1) {
        stoppedBecause = 'The model stopped without calling report_result.'
        break
      }
      messages.push({ role: 'assistant', content: message.content })
      messages.push({
        role: 'user',
        content:
          'You have not called report_result yet. Call it now with an honest status, summary and warnings.'
      })
      continue
    }

    messages.push({ role: 'assistant', content: message.content })

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const use of toolUses) {
      log.debug(`tool: ${use.name}`)
      let outcome: Awaited<ReturnType<typeof runTool>>
      try {
        outcome = await runTool(use.name, use.input, toolContext, state)
      } catch (error) {
        outcome = {
          content: `ERROR: the tool threw: ${(error as Error).message}`,
          isError: true
        }
      }
      if (outcome.isError) log.warn(`${use.name}: ${outcome.content}`)
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: outcome.content,
        is_error: outcome.isError
      })
    }

    // All results for one assistant turn go back in a single user message.
    messages.push({ role: 'user', content: results })

    if (state.finalReport) break
  }

  if (turns >= MAX_TURNS && !state.finalReport && stoppedBecause === null) {
    stoppedBecause = `Stopped after ${MAX_TURNS} turns without a final report.`
  }

  log.info(
    `Agent finished after ${turns} turn(s): ${usage.inputTokens} input / ${usage.outputTokens} output tokens`
  )

  return {
    report: state.finalReport,
    touchedPaths: [...state.touchedPaths].sort(),
    turns,
    stoppedBecause,
    usage
  }
}
