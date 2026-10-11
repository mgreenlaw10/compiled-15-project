/**
 * The agent loop.
 *
 * A hand-written loop rather than any SDK's tool runner, because every turn has
 * to be reported to the GUI's activity panel, the loop has to be cancellable
 * mid-task, and the tools need the virtual workspace threaded through them.
 *
 * It is written against the protocol-neutral `ChatModel` in
 * `./providers/chat.ts` and names no vendor, so one loop drives Anthropic's
 * native API and any OpenAI-compatible endpoint alike. Provider-specific
 * behaviour — prompt caching, thinking, refusal fallbacks, tool-call
 * translation — belongs in the provider module, not here.
 *
 * Tool inputs are re-validated client-side in `runTool` before anything runs:
 * providers that stream tool inputs eagerly stop validating them server-side,
 * and an OpenAI-compatible gateway never validated them in the first place.
 */

import type { GraphOperation } from '../../shared/types/operations'
import type { ChannelLogger } from '../logger'
import { describeApiError, type AiClient } from './client'
import {
  textOf,
  toolUsesOf,
  type ChatMessage,
  type ChatResponse,
  type ChatToolResult
} from './providers/chat'
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
/** Transient transport failures worth re-issuing the turn for. */
const MAX_CALL_RETRIES = 2

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

export async function runAgent(options: RunAgentOptions): Promise<AgentOutcome> {
  const { client, log, operation } = options
  const tools = toolDefinitions()
  const state = createToolRunState()
  const toolContext: ToolRunContext = {
    ...options.toolContext,
    operation,
    maxFileReads: client.maxFileReads
  }

  const messages: ChatMessage[] = [{ role: 'user', content: options.task }]

  let turns = 0
  let retries = 0
  let stoppedBecause: string | null = null
  const usage = { inputTokens: 0, outputTokens: 0 }

  log.info(
    client.chat.capabilities.effort
      ? `Starting ${client.model} at effort "${client.effort}"`
      : `Starting ${client.model}`
  )

  while (turns < MAX_TURNS) {
    if (options.signal?.aborted) {
      stoppedBecause = 'Canceled by the user.'
      break
    }
    turns += 1

    let response: ChatResponse
    try {
      response = await client.chat.complete({
        system: SYSTEM_PROMPT,
        messages,
        tools,
        maxTokens: MAX_TOKENS,
        ...(options.signal ? { signal: options.signal } : {}),
        // Only streaming providers call this; the rest log the turn's text
        // once it arrives, below.
        onText: client.chat.capabilities.streaming
          ? (delta) => {
              if (delta.trim() !== '') log.debug(delta.trim())
            }
          : undefined
      })
      retries = 0
    } catch (error) {
      if (options.signal?.aborted) {
        stoppedBecause = 'Canceled by the user.'
        break
      }
      if (retries < MAX_CALL_RETRIES) {
        retries += 1
        log.warn(
          `The model call failed; retrying (${retries}/${MAX_CALL_RETRIES})`,
          (error as Error).message
        )
        turns -= 1
        continue
      }
      stoppedBecause = describeApiError(error, client.providerId)
      log.error('The model call failed', stoppedBecause)
      break
    }

    usage.inputTokens += response.usage.inputTokens
    usage.outputTokens += response.usage.outputTokens

    for (const block of response.content) {
      if (block.type === 'thinking' && block.thinking.trim() !== '') {
        log.debug(`thinking: ${block.thinking.trim()}`)
      }
    }
    const said = textOf(response)
    if (said !== '') log.info(said)

    if (response.stopReason === 'refusal') {
      stoppedBecause = `The model declined this request${
        response.refusalCategory ? ` (${response.refusalCategory})` : ''
      }. No tools from that turn were run.`
      log.warn(stoppedBecause)
      break
    }

    if (response.stopReason === 'max_tokens') {
      stoppedBecause =
        'The model hit its output limit mid-turn, so the turn was discarded rather than half-applied.'
      log.warn(stoppedBecause)
      break
    }

    if (response.stopReason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }

    const toolUses = toolUsesOf(response)

    if (toolUses.length === 0) {
      // The model is done talking but never reported. Ask once, then give up
      // rather than looping.
      if (state.finalReport) break
      if (turns >= MAX_TURNS - 1) {
        stoppedBecause = 'The model stopped without calling report_result.'
        break
      }
      messages.push({ role: 'assistant', content: response.content })
      messages.push({
        role: 'user',
        content:
          'You have not called report_result yet. Call it now with an honest status, summary and warnings.'
      })
      continue
    }

    messages.push({ role: 'assistant', content: response.content })

    const results: ChatToolResult[] = []
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
        toolUseId: use.id,
        content: outcome.content,
        isError: outcome.isError
      })
    }

    // All results for one assistant turn go back together.
    messages.push({ role: 'tool_results', results })

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
