/**
 * The Anthropic client wrapper.
 *
 * Cartograph is usable with no API key at all: every deterministic path — scan,
 * analyze, cluster, graph edit, file move, symbol move, generate, validate —
 * runs without this module ever being loaded. It is constructed lazily, only
 * when an operation genuinely needs a model, so a user without a key never
 * sees an auth error.
 */

import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError
} from '@anthropic-ai/sdk'

import {
  DEFAULT_AI_CONFIG,
  DEFAULT_MODEL,
  type AiConfig,
  type Effort
} from '../../shared/types/ai'

export {
  DEFAULT_AI_CONFIG,
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  SUGGESTED_MODELS,
  type AiConfig,
  type Effort
} from '../../shared/types/ai'

export interface AiClient {
  readonly sdk: Anthropic
  readonly model: string
  readonly effort: Effort
  readonly maxFileReads: number
}

export function isConfigured(config: Partial<AiConfig> | null): boolean {
  return typeof config?.apiKey === 'string' && config.apiKey.trim().length > 0
}

export function createAiClient(config: AiConfig): AiClient {
  return {
    sdk: new Anthropic({
      apiKey: config.apiKey,
      // Agent turns can be long; the per-request default is generous enough,
      // but a slow tool round-trip should not kill a half-finished refactor.
      timeout: 15 * 60 * 1000,
      maxRetries: 2
    }),
    model: config.model || DEFAULT_MODEL,
    effort: config.effort ?? 'high',
    maxFileReads: config.maxFileReads ?? DEFAULT_AI_CONFIG.maxFileReads
  }
}

/** Sends the smallest possible request, to check a key really works. */
export async function testApiKey(
  config: AiConfig
): Promise<{ ok: boolean; message: string }> {
  if (!isConfigured(config)) {
    return { ok: false, message: 'No API key is configured.' }
  }
  const client = createAiClient(config)
  try {
    const response = await client.sdk.messages.create({
      model: client.model,
      max_tokens: 16,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }]
    })
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
    return {
      ok: true,
      message: `${client.model} responded${text ? `: "${text}"` : ''} (${response.usage.input_tokens} in / ${response.usage.output_tokens} out).`
    }
  } catch (error) {
    return { ok: false, message: describeApiError(error) }
  }
}

/** Turns an SDK error into something worth showing a user. */
export function describeApiError(error: unknown): string {
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
