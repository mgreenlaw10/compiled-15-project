/**
 * The model-client facade.
 *
 * Everything in `src/core` that needs a model goes through these four
 * functions and never names a vendor. Which provider answers is decided by
 * `config.provider` and resolved through the registry in `./providers`, so
 * adding a provider is a change under that directory and nowhere else.
 *
 * Cartograph is usable with no API key at all: every deterministic path — scan,
 * analyze, cluster, graph edit, file move, symbol move, generate, validate —
 * runs without a provider ever being constructed. Clients are built lazily,
 * only when an operation genuinely needs a model, so a user without a key
 * never sees an auth error.
 */

import {
  DEFAULT_PROVIDER_ID,
  providerOrDefault,
  type AiConfig
} from '../../shared/ai'
import { requireAiProvider } from './providers'
import type { AiClient } from './providers/types'

export type { AiClient, AiProvider, ApiKeyTest } from './providers/types'
export { findAiProvider, implementedProviderIds } from './providers'

export function isConfigured(config: Partial<AiConfig> | null): boolean {
  return typeof config?.apiKey === 'string' && config.apiKey.trim().length > 0
}

/** Fills in whatever a caller left out, from the provider's own defaults. */
export function resolveAiConfig(config: Partial<AiConfig>): AiConfig {
  const descriptor = providerOrDefault(config.provider ?? DEFAULT_PROVIDER_ID)
  return {
    provider: descriptor.id,
    apiKey: config.apiKey ?? '',
    model: config.model || descriptor.defaultModel,
    effort: config.effort ?? descriptor.defaultEffort,
    maxFileReads: config.maxFileReads ?? 40
  }
}

export function createAiClient(config: AiConfig): AiClient {
  const resolved = resolveAiConfig(config)
  return requireAiProvider(resolved.provider).createClient(resolved)
}

/** Sends the smallest possible request, to check a key really works. */
export async function testApiKey(
  config: AiConfig
): Promise<{ ok: boolean; message: string }> {
  if (!isConfigured(config)) {
    return { ok: false, message: 'No API key is configured.' }
  }
  const resolved = resolveAiConfig(config)
  return requireAiProvider(resolved.provider).testApiKey(resolved)
}

/**
 * Turns a provider error into something worth showing a user.
 *
 * Takes the provider id when the caller knows it — an `AiClient` carries one —
 * and falls back to the default provider's reading of the error otherwise,
 * which is still better than `String(error)` for the common cases.
 */
export function describeApiError(
  error: unknown,
  providerId: string = DEFAULT_PROVIDER_ID
): string {
  return requireAiProvider(providerId).describeError(error)
}
