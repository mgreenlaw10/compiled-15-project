/**
 * The Anthropic provider.
 *
 * The reference implementation of `AiProvider`: a thin wrapper over the
 * official SDK plus error messages a user can act on.
 */

import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError
} from '@anthropic-ai/sdk'

import type { AiConfig } from '../../../shared/ai'
import { providerOrDefault } from '../../../shared/ai'
import type { AiClient, AiProvider, ApiKeyTest } from './types'

const PROVIDER_ID = 'anthropic'

/**
 * Agent turns can be long; the per-request default is generous enough, but a
 * slow tool round-trip should not kill a half-finished refactor.
 */
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000

function createClient(config: AiConfig): AiClient {
  const descriptor = providerOrDefault(PROVIDER_ID)
  return {
    providerId: PROVIDER_ID,
    sdk: new Anthropic({
      apiKey: config.apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 2
    }),
    model: config.model || descriptor.defaultModel,
    effort: config.effort ?? descriptor.defaultEffort,
    maxFileReads: config.maxFileReads
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
    return { ok: false, message: describeError(error) }
  }
}

export const anthropicProvider: AiProvider = {
  id: PROVIDER_ID,
  createClient,
  describeError,
  testApiKey
}
