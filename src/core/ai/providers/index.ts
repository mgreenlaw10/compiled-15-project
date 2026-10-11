/**
 * The provider registry.
 *
 * ---------------------------------------------------------------------------
 * Adding a provider
 * ---------------------------------------------------------------------------
 * 1. Add its descriptor to `src/shared/ai/providers.ts` (renderer-safe
 *    metadata: display name, models, key placeholder, console URL, env var).
 * 2. Write `./<name>.ts` exporting an `AiProvider`.
 * 3. Add it to `PROVIDERS` below.
 *
 * That is the whole change. `createAiClient`, `testApiKey` and
 * `describeApiError` in `../client.ts` dispatch through this registry, the
 * settings store keys credentials off the descriptor id, and the settings
 * dialog renders from the catalog — so no caller, test or UI file needs
 * touching.
 *
 * If a provider does not speak the Anthropic message protocol, adapt it to the
 * `AiClient` shape *inside its own module*. Everything downstream
 * (`agent.ts`, `enrich.ts`) is written against that shape, and keeping the
 * adaptation local is what makes a second provider a one-file change.
 */

import { DEFAULT_PROVIDER_ID } from '../../../shared/ai'
import { anthropicProvider } from './anthropic'
import type { AiProvider } from './types'

export * from './types'

const PROVIDERS: readonly AiProvider[] = [anthropicProvider]

export function findAiProvider(id: string): AiProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null
}

/** Ids of providers with a working implementation. */
export function implementedProviderIds(): string[] {
  return PROVIDERS.map((p) => p.id)
}

/**
 * The provider for `id`, or an explanatory throw. Callers reach this only
 * after `isConfigured` has confirmed a key, so an unknown id here means a
 * descriptor was added to the catalog without an implementation.
 */
export function requireAiProvider(id: string): AiProvider {
  const provider = findAiProvider(id)
  if (provider) return provider
  const fallback = findAiProvider(DEFAULT_PROVIDER_ID)
  if (fallback) return fallback
  throw new Error(
    `No AI provider is registered for "${id}". Register one in src/core/ai/providers/index.ts.`
  )
}
