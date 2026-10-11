/**
 * The AI provider catalog.
 *
 * Renderer-safe metadata about each provider Cartograph can talk to: how to
 * label it, which models it offers, what its keys look like, and where to get
 * one. No vendor SDK is imported here, so the settings dialog can render the
 * whole catalog without the renderer bundle growing a dependency on it.
 *
 * ---------------------------------------------------------------------------
 * Adding a provider
 * ---------------------------------------------------------------------------
 * 1. Add a descriptor to `AI_PROVIDERS` below.
 * 2. Add the matching client factory under `src/core/ai/providers/` and
 *    register it in that directory's `index.ts`.
 *
 * Nothing else needs to change: settings storage keys off the descriptor id,
 * the settings dialog renders from this list, and the pipeline only ever sees
 * an `AiConfig`.
 */

import type { Effort } from './config'

export interface AiProviderDescriptor {
  /** Stable key. Used as the settings storage key, so never rename one. */
  id: string
  displayName: string
  /** One line for the settings dialog. */
  summary: string
  /** Models offered in the settings dialog, most capable first. */
  models: readonly string[]
  defaultModel: string
  defaultEffort: Effort
  /** Placeholder shown in the key field, e.g. `sk-ant-…`. */
  keyPlaceholder: string
  /** Where a user gets a key. Opened in the system browser, never in-app. */
  consoleUrl: string
  /** Environment variable read as a fallback when no key is stored. */
  envVar: string
  /** `false` for providers that are registered but not yet implemented. */
  available: boolean
}

export const AI_PROVIDERS: readonly AiProviderDescriptor[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    summary:
      'Claude models, called directly. Claude Opus 5.5 is the default and the most capable.',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    defaultModel: 'claude-opus-5-5',
    defaultEffort: 'high',
    keyPlaceholder: 'sk-ant-…',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    envVar: 'ANTHROPIC_API_KEY',
    available: true
  },
  {
    id: 'luminal',
    displayName: 'Luminal',
    summary:
      'DeepSeek V4.1 Flash through Luminal’s OpenAI-compatible Flash endpoint. Get a key from dash.luminal.com.',
    models: ['deepseek-ai/DeepSeek-V4.1-Flash'],
    defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
    defaultEffort: 'high',
    keyPlaceholder: 'your Luminal API key',
    consoleUrl: 'https://dash.luminal.com',
    envVar: 'LUMINAL_API_KEY',
    available: true
  }
]

/**
 * A provider id. Deliberately a plain `string` rather than a union of the
 * catalog's ids: that keeps adding a provider to a single edit of the list
 * above instead of a type error in every `Record<AiProviderId, …>` in the
 * codebase. Use `isKnownProvider` where a value needs checking.
 */
export type AiProviderId = string

export const DEFAULT_PROVIDER_ID: AiProviderId = 'anthropic'

export function findProvider(id: AiProviderId): AiProviderDescriptor | null {
  return AI_PROVIDERS.find((p) => p.id === id) ?? null
}

export function isKnownProvider(id: unknown): id is AiProviderId {
  return typeof id === 'string' && AI_PROVIDERS.some((p) => p.id === id)
}

/** The descriptor for `id`, falling back to the default provider. */
export function providerOrDefault(id: AiProviderId): AiProviderDescriptor {
  return findProvider(id) ?? findProvider(DEFAULT_PROVIDER_ID) ?? AI_PROVIDERS[0]
}

/** Providers that can actually be used today, for the settings dialog. */
export function availableProviders(): AiProviderDescriptor[] {
  return AI_PROVIDERS.filter((p) => p.available)
}
