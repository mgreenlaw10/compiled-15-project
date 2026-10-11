/**
 * A `ChatModel` over an OpenAI-compatible `/chat/completions` endpoint.
 *
 * Written against `fetch` rather than the OpenAI SDK on purpose: the surface
 * used here is small, and "OpenAI-compatible" gateways vary in exactly the
 * places a strict SDK client would reject (missing `usage`, a `reasoning_content`
 * field, tool arguments arriving as an already-parsed object). Being lenient
 * about the response and strict about the request is what makes one
 * implementation serve several providers.
 *
 * Shared by any provider whose descriptor points at such an endpoint; see
 * `./luminal.ts` for a user of it.
 */

import type {
  ChatBlock,
  ChatCapabilities,
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ChatTool
} from './chat'

export interface OpenAiCompatibleOptions {
  /** Base URL including the version segment, e.g. `https://host/v1`. */
  baseUrl: string
  apiKey: string
  model: string
  /** Sent as `Api-Key` in addition to the bearer token, when a host wants it. */
  sendApiKeyHeader?: boolean
  /** How well the endpoint enforces structured output. */
  jsonMode?: ChatCapabilities['jsonMode']
  /**
   * Echo the reasoning the endpoint produced back on the assistant turn, as
   * `reasoning_content`. Hosts whose thinking mode is stateless over the chat
   * protocol require this: without it a second turn is rejected, which ends a
   * tool-using agent run after its first reply. Off by default, because a
   * gateway that does not know the field may reject the request instead.
   */
  replayReasoning?: boolean
  /** Extra headers, e.g. a gateway's routing hints. */
  headers?: Record<string, string>
  /** Request timeout. Agent turns can be long; tool round-trips add up. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

// --- wire shapes (only the fields that are read) ---------------------------

interface WireToolCall {
  id?: string
  function?: { name?: string; arguments?: unknown }
}

interface WireChoice {
  finish_reason?: string
  message?: {
    content?: string | null
    /** DeepSeek and some gateways expose reasoning separately. */
    reasoning_content?: string | null
    reasoning?: string | null
    refusal?: string | null
    tool_calls?: WireToolCall[]
  }
}

interface WireResponse {
  choices?: WireChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    input_tokens?: number
    output_tokens?: number
  }
  error?: { message?: string; type?: string; code?: string }
}

/**
 * An error carrying the HTTP status, so `describeError` can say something
 * useful without every provider inventing its own error class.
 */
export class OpenAiCompatibleError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: string
  ) {
    super(message)
    this.name = 'OpenAiCompatibleError'
  }
}

function toWireTools(tools: readonly ChatTool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }))
}

/** Our message list, flattened into the role sequence the API expects. */
function toWireMessages(
  system: string,
  messages: ChatMessage[],
  replayReasoning: boolean
): unknown[] {
  const wire: unknown[] = [{ role: 'system', content: system }]

  for (const message of messages) {
    if (message.role === 'user') {
      wire.push({ role: 'user', content: message.content })
      continue
    }

    if (message.role === 'tool_results') {
      // One `tool` message per result, each tied to its call id.
      for (const result of message.results) {
        wire.push({
          role: 'tool',
          tool_call_id: result.toolUseId,
          content: result.isError ? `ERROR: ${result.content}` : result.content
        })
      }
      continue
    }

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('')
    const toolCalls = message.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => {
        const use = block as { id: string; name: string; input: unknown }
        return {
          id: use.id,
          type: 'function',
          function: {
            name: use.name,
            arguments: JSON.stringify(use.input ?? {})
          }
        }
      })

    // Thinking is never replayed as assistant *text* -- reasoning read back as
    // a reply confuses more than it helps. It goes back in the field it came
    // from, and only for hosts that ask for it, because their thinking mode
    // keeps no state of its own between turns.
    const reasoning = replayReasoning
      ? message.content
          .filter((block) => block.type === 'thinking')
          .map((block) => (block as { thinking: string }).thinking)
          .join('')
      : ''

    wire.push({
      role: 'assistant',
      content: text === '' ? null : text,
      ...(reasoning === '' ? {} : { reasoning_content: reasoning }),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    })
  }

  return wire
}

function toStopReason(
  finishReason: string | undefined,
  hasToolCalls: boolean,
  refused: boolean
): ChatStopReason {
  if (refused) return 'refusal'
  if (hasToolCalls) return 'tool_use'
  switch (finishReason) {
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    default:
      return 'end_turn'
  }
}

/** Tool arguments may arrive as a JSON string or as an object. */
function parseToolArguments(raw: unknown): unknown {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    // Returned as-is so the caller's validation reports a useful message
    // rather than the loop dying on a malformed argument string.
    return { __unparsed: raw }
  }
}

export function createOpenAiCompatibleModel(
  options: OpenAiCompatibleOptions
): ChatModel {
  const jsonMode = options.jsonMode ?? 'object'
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`

  return {
    capabilities: {
      // Responses are requested whole: the agent's text is logged after each
      // turn anyway, and non-streaming keeps the tool-call parsing simple
      // across gateways that chunk deltas differently.
      streaming: false,
      jsonMode,
      thinking: true,
      // There is no `effort` equivalent in the OpenAI chat protocol.
      effort: false
    },

    async complete(request: ChatRequest): Promise<ChatResponse> {
      const body: Record<string, unknown> = {
        model: options.model,
        max_tokens: request.maxTokens,
        messages: toWireMessages(
          request.system,
          request.messages,
          options.replayReasoning ?? false
        )
      }

      if (request.tools && request.tools.length > 0) {
        body.tools = toWireTools(request.tools)
        body.tool_choice = 'auto'
      }

      if (request.responseSchema) {
        body.response_format =
          jsonMode === 'schema'
            ? {
                type: 'json_schema',
                json_schema: {
                  name: 'response',
                  strict: true,
                  schema: request.responseSchema
                }
              }
            : { type: 'json_object' }
      }

      // The caller's signal cancels the refactor; the timeout stops a hung
      // connection. Either aborts the request.
      const timeout = new AbortController()
      const timer = setTimeout(
        () => timeout.abort(),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      )
      const onAbort = (): void => timeout.abort()
      request.signal?.addEventListener('abort', onAbort)

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
            ...(options.sendApiKeyHeader ? { 'Api-Key': options.apiKey } : {}),
            ...options.headers
          },
          body: JSON.stringify(body),
          signal: timeout.signal
        })
      } catch (error) {
        if (request.signal?.aborted) throw error
        throw new OpenAiCompatibleError(
          `Could not reach ${endpoint}: ${(error as Error).message}`,
          null
        )
      } finally {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
      }

      const raw = await response.text()

      if (!response.ok) {
        let detail = raw.slice(0, 400)
        try {
          const parsed = JSON.parse(raw) as WireResponse
          if (parsed.error?.message) detail = parsed.error.message
        } catch {
          // Not JSON; the raw body excerpt is the best available detail.
        }
        throw new OpenAiCompatibleError(detail, response.status, raw)
      }

      let parsed: WireResponse
      try {
        parsed = JSON.parse(raw) as WireResponse
      } catch {
        throw new OpenAiCompatibleError(
          `The endpoint returned a non-JSON body: ${raw.slice(0, 200)}`,
          response.status,
          raw
        )
      }

      const choice = parsed.choices?.[0]
      const message = choice?.message
      const content: ChatBlock[] = []

      const reasoning = message?.reasoning_content ?? message?.reasoning
      if (typeof reasoning === 'string' && reasoning.trim() !== '') {
        content.push({ type: 'thinking', thinking: reasoning })
      }

      const text = message?.content
      if (typeof text === 'string' && text !== '') {
        content.push({ type: 'text', text })
        request.onText?.(text)
      }

      const toolCalls = message?.tool_calls ?? []
      for (const [index, call] of toolCalls.entries()) {
        const name = call.function?.name
        if (!name) continue
        content.push({
          type: 'tool_use',
          // Gateways occasionally omit the id; the index keeps results
          // correlated within the turn, which is all it is used for.
          id: call.id ?? `call_${index}`,
          name,
          input: parseToolArguments(call.function?.arguments)
        })
      }

      const refused =
        typeof message?.refusal === 'string' && message.refusal.trim() !== ''
      if (refused && content.length === 0) {
        content.push({ type: 'text', text: message.refusal as string })
      }

      const usage = parsed.usage ?? {}
      return {
        content,
        stopReason: toStopReason(
          choice?.finish_reason,
          toolCalls.length > 0,
          refused
        ),
        usage: {
          inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0
        },
        ...(refused ? { refusalCategory: 'refusal' } : {})
      }
    }
  }
}

/** Shared error wording for OpenAI-compatible hosts. */
export function describeOpenAiCompatibleError(
  error: unknown,
  providerName: string
): string {
  if (error instanceof OpenAiCompatibleError) {
    switch (error.status) {
      case 401:
        return `The ${providerName} API key was rejected (401). Check the key in Settings.`
      case 403:
        return `That ${providerName} key does not have access to this model (403).`
      case 404:
        return `${providerName} did not recognise the model or endpoint (404). Check the model in Settings.`
      case 429:
        return `Rate limited by ${providerName} (429). Wait a moment and try again.`
      case null:
        return error.message
      default:
        return `${providerName} returned ${error.status}: ${error.message}`
    }
  }
  if (error instanceof Error) return error.message
  return String(error)
}
