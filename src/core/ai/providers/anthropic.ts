/**
 * The Anthropic provider.
 *
 * Implements `ChatModel` over the official SDK. Everything Anthropic-specific
 * lives here and nowhere else: prompt caching of the system/tool prefix,
 * adaptive thinking, server-side refusal fallbacks, eager tool-input streaming,
 * and the beta message surface.
 *
 * Requests stream — tool inputs here include whole file contents, which is
 * exactly the case streaming exists for — and because eager input streaming
 * means the server stops validating tool inputs, the caller re-validates every
 * one before running it.
 */

import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError
} from '@anthropic-ai/sdk'

import { providerOrDefault, type AiConfig } from '../../../shared/ai'
import type {
  ChatBlock,
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ChatTool
} from './chat'
import type { AiClient, AiProvider, ApiKeyTest } from './types'

const PROVIDER_ID = 'anthropic'

/**
 * Agent turns can be long; the per-request default is generous enough, but a
 * slow tool round-trip should not kill a half-finished refactor.
 */
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000

/** Server-side refusal fallbacks: routes by refusal category automatically. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** `true` when the API rejected the request because of the fallbacks beta. */
function isFallbackRejection(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status !== 400) return false
  const message = error.message.toLowerCase()
  return message.includes('fallback') || message.includes('beta')
}

function toSdkTools(tools: readonly ChatTool[]): Anthropic.Beta.BetaTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    // Large tool inputs (whole file contents) stream as they are generated.
    // The client then owns validation — see `runTool`.
    eager_input_streaming: true
  }))
}

function toSdkMessages(
  messages: ChatMessage[]
): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content }
    }
    if (message.role === 'tool_results') {
      return {
        role: 'user',
        content: message.results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.toolUseId,
          content: result.content,
          is_error: result.isError
        }))
      }
    }
    return {
      role: 'assistant',
      content: message.content.map((block) => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text }
        }
        if (block.type === 'thinking') {
          // Signed thinking blocks cannot be reconstructed from our neutral
          // shape, so reasoning is not replayed. The conversation stays valid
          // because text and tool_use carry the turn's actual content.
          return { type: 'text' as const, text: '' }
        }
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input
        }
      }).filter((block) => block.type !== 'text' || block.text !== '')
    }
  })
}

function fromSdkContent(
  content: Anthropic.Beta.BetaMessage['content']
): ChatBlock[] {
  const blocks: ChatBlock[] = []
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', thinking: block.thinking })
    } else if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input
      })
    }
  }
  return blocks
}

function toStopReason(
  message: Anthropic.Beta.BetaMessage,
  hasToolUse: boolean
): ChatStopReason {
  switch (message.stop_reason) {
    case 'refusal':
      return 'refusal'
    case 'max_tokens':
      return 'max_tokens'
    case 'pause_turn':
      return 'pause_turn'
    default:
      return hasToolUse ? 'tool_use' : 'end_turn'
  }
}

function createChatModel(sdk: Anthropic, config: AiConfig): ChatModel {
  const descriptor = providerOrDefault(PROVIDER_ID)
  const model = config.model || descriptor.defaultModel
  const effort = config.effort ?? descriptor.defaultEffort

  // Flipped off permanently for this client if the deployment rejects the
  // beta, so one 400 does not cost a retry on every later turn.
  let useFallbacks = true

  const send = async (
    request: ChatRequest,
    withFallbacks: boolean
  ): Promise<Anthropic.Beta.BetaMessage> => {
    const stream = sdk.beta.messages.stream({
      model,
      max_tokens: request.maxTokens,
      system: [
        {
          type: 'text',
          text: request.system,
          // The system prompt and tool list are identical every turn, so the
          // whole prefix is cached and only the growing tail is re-read.
          cache_control: { type: 'ephemeral' }
        }
      ],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: {
        effort,
        ...(request.responseSchema
          ? {
              format: {
                type: 'json_schema' as const,
                schema: request.responseSchema
              }
            }
          : {})
      },
      ...(request.tools && request.tools.length > 0
        ? { tools: toSdkTools(request.tools) }
        : {}),
      messages: toSdkMessages(request.messages),
      ...(withFallbacks
        ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const }
        : {}),
      ...(request.signal ? { signal: request.signal } : {})
    })

    if (request.onText) {
      stream.on('text', (delta) => request.onText?.(delta))
    }
    return stream.finalMessage()
  }

  return {
    capabilities: {
      streaming: true,
      jsonMode: 'schema',
      thinking: true,
      effort: true
    },

    async complete(request: ChatRequest): Promise<ChatResponse> {
      let message: Anthropic.Beta.BetaMessage
      try {
        message = await send(request, useFallbacks)
      } catch (error) {
        if (useFallbacks && isFallbackRejection(error)) {
          // The deployment does not accept the fallbacks beta; carry on
          // without it rather than failing the user's refactor over a
          // resilience extra.
          useFallbacks = false
          message = await send(request, false)
        } else {
          throw error
        }
      }

      const content = fromSdkContent(message.content)
      const hasToolUse = content.some((block) => block.type === 'tool_use')

      return {
        content,
        stopReason: toStopReason(message, hasToolUse),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens
        },
        ...(message.stop_reason === 'refusal' &&
        message.stop_details &&
        'category' in message.stop_details
          ? { refusalCategory: String(message.stop_details.category) }
          : {})
      }
    }
  }
}

function createClient(config: AiConfig): AiClient {
  const descriptor = providerOrDefault(PROVIDER_ID)
  const sdk = new Anthropic({
    apiKey: config.apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2
  })

  return {
    providerId: PROVIDER_ID,
    model: config.model || descriptor.defaultModel,
    effort: config.effort ?? descriptor.defaultEffort,
    maxFileReads: config.maxFileReads,
    chat: createChatModel(sdk, config)
  }
}

function describeError(error: unknown): string {
  if (error instanceof AuthenticationError) {
    return 'The API key was rejected (401). Check the key in Settings.'
  }
  if (error instanceof PermissionDeniedError) {
    return 'That key does not have access to this model (403).'
  }
  if (error instanceof NotFoundError) {
    return 'The model name was not recognised (404). Check the model in Settings.'
  }
  if (error instanceof RateLimitError) {
    return 'Rate limited (429). Wait a moment and try again.'
  }
  if (error instanceof APIConnectionError) {
    return `Could not reach the API: ${error.message}`
  }
  if (error instanceof APIError) {
    return `The API returned ${error.status ?? 'an error'}: ${error.message}`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

async function testApiKey(config: AiConfig): Promise<ApiKeyTest> {
  const client = createClient(config)
  try {
    const response = await client.chat.complete({
      system: 'You are a connectivity check. Answer with one word.',
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      maxTokens: 16
    })
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('')
      .trim()
    return {
      ok: true,
      message: `${client.model} responded${text ? `: "${text}"` : ''} (${response.usage.inputTokens} in / ${response.usage.outputTokens} out).`
    }
  } catch (error) {
    return { ok: false, message: describeError(error) }
  }
}

export const anthropicProvider: AiProvider = {
  id: PROVIDER_ID,
  createClient,
  describeError,
  testApiKey
}
