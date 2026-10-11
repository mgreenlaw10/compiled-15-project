/**
 * The Luminal provider.
 *
 * Luminal's Flash endpoint is OpenAI-compatible, so the transport is the shared
 * `./openai-compatible.ts` implementation and this file is just configuration
 * plus error wording. Keys come from dash.luminal.com and are sent as a bearer
 * token.
 *
 * Structured output is requested as `json_object` rather than `json_schema`:
 * the gateway accepts the request either way, but only JSON-validity is
 * dependable across models, so `enrich.ts` parses leniently. Tool calling is
 * used as-is, which is what lets the agent create modules and edit code.
 *
 * Luminal also exposes an Ideogram-compatible image API at
 * `https://images.luminal.cloud/`. Cartograph has nothing to do with image
 * generation, so it is deliberately not wired up here.
 */

import { providerOrDefault, type AiConfig } from '../../../shared/ai'
import type { AiClient, AiProvider, ApiKeyTest } from './types'
import {
  createOpenAiCompatibleModel,
  describeOpenAiCompatibleError
} from './openai-compatible'

const PROVIDER_ID = 'luminal'

/** Flash's OpenAI-compatible chat endpoint, including the version segment. */
export const LUMINAL_BASE_URL = 'https://flash.luminal.cloud/v1'

function createClient(config: AiConfig): AiClient {
  const descriptor = providerOrDefault(PROVIDER_ID)
  const model = config.model || descriptor.defaultModel

  return {
    providerId: PROVIDER_ID,
    model,
    effort: config.effort ?? descriptor.defaultEffort,
    maxFileReads: config.maxFileReads,
    chat: createOpenAiCompatibleModel({
      baseUrl: LUMINAL_BASE_URL,
      apiKey: config.apiKey,
      model,
      // Valid JSON is dependable; strict schema adherence is not.
      jsonMode: 'object'
    })
  }
}

function describeError(error: unknown): string {
  return describeOpenAiCompatibleError(error, 'Luminal')
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

export const luminalProvider: AiProvider = {
  id: PROVIDER_ID,
  createClient,
  describeError,
  testApiKey
}
