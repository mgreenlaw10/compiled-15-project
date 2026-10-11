/**
 * The protocol-neutral chat interface.
 *
 * `agent.ts` and `enrich.ts` are written against this, not against any vendor
 * SDK, so a provider that speaks a different wire protocol is a new file in
 * this directory rather than a second code path through the agent loop.
 *
 * The shape is the intersection of what the agent actually needs: a system
 * prompt, a message list, tool definitions, tool results, and a stop reason it
 * can act on. Anything a provider offers beyond that (prompt caching, adaptive
 * thinking, server-side fallbacks, strict JSON schemas) is the provider's
 * business and is applied inside its own module — declared through
 * `ChatCapabilities` where a caller has to adapt.
 */

/** One tool, as the model sees it. */
export interface ChatTool {
  name: string
  description: string
  /** JSON Schema (draft-07) for the tool's input. */
  inputSchema: Record<string, unknown>
}

export interface ChatTextBlock {
  type: 'text'
  text: string
}

/** Reasoning the model chose to expose. Logged, never fed back as text. */
export interface ChatThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface ChatToolUseBlock {
  type: 'tool_use'
  /** Correlates with the `toolUseId` of the result sent back. */
  id: string
  name: string
  /** Parsed tool input. Always re-validated by the caller before running. */
  input: unknown
}

export type ChatBlock = ChatTextBlock | ChatThinkingBlock | ChatToolUseBlock

export interface ChatToolResult {
  toolUseId: string
  content: string
  isError: boolean
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: ChatBlock[] }
  | { role: 'tool_results'; results: ChatToolResult[] }

/**
 * Why the model stopped.
 *
 * `refusal` and `max_tokens` both mean "discard this turn": the agent must not
 * half-apply a truncated turn, and must not run tools from a refused one.
 */
export type ChatStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
}

export interface ChatResponse {
  content: ChatBlock[]
  stopReason: ChatStopReason
  usage: ChatUsage
  /** Refusal category, when the provider reports one. */
  refusalCategory?: string
}

export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  tools?: readonly ChatTool[]
  maxTokens: number
  /**
   * A JSON Schema the response text must satisfy. Providers that cannot
   * enforce it should still ask for JSON — see `ChatCapabilities.jsonMode`.
   */
  responseSchema?: Record<string, unknown>
  signal?: AbortSignal
  /** Called with streamed text as it arrives, for the activity log. */
  onText?: (delta: string) => void
}

/** What a provider can and cannot do, where the caller has to care. */
export interface ChatCapabilities {
  /** `true` when the provider streams text deltas to `onText`. */
  streaming: boolean
  /**
   * How well structured output is enforced:
   *   `schema` — the response is guaranteed to match `responseSchema`
   *   `object` — valid JSON is guaranteed, but not the schema
   *   `none`   — neither; the caller must tolerate prose around the JSON
   */
  jsonMode: 'schema' | 'object' | 'none'
  /** `true` when the provider exposes reasoning as thinking blocks. */
  thinking: boolean
  /**
   * `true` when the provider actually acts on `AiConfig.effort`. OpenAI-style
   * endpoints have no equivalent, and the activity log should not claim an
   * effort level was applied when it was ignored.
   */
  effort: boolean
}

/** One configured model, ready to call. */
export interface ChatModel {
  readonly capabilities: ChatCapabilities
  complete(request: ChatRequest): Promise<ChatResponse>
}

/** Concatenated text of a response, trimmed. */
export function textOf(response: ChatResponse): string {
  return response.content
    .filter((block): block is ChatTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

export function toolUsesOf(response: ChatResponse): ChatToolUseBlock[] {
  return response.content.filter(
    (block): block is ChatToolUseBlock => block.type === 'tool_use'
  )
}

/**
 * Pulls a JSON object out of model text.
 *
 * With `jsonMode: 'schema'` the text is already JSON and this is a plain parse.
 * With weaker modes a model may wrap it in a fenced block or a sentence, so the
 * outermost braces are located rather than failing the whole operation over
 * punctuation. Returns `null` when there is no parseable object, which callers
 * treat as "the model did not answer" rather than throwing.
 */
export function parseJsonObject<T>(text: string): T | null {
  const trimmed = text.trim()
  const candidates: string[] = [trimmed]

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fenced) candidates.push(fenced[1].trim())

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed !== null && typeof parsed === 'object') return parsed as T
    } catch {
      // Try the next candidate.
    }
  }
  return null
}
