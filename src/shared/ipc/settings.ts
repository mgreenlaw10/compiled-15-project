/**
 * Application settings.
 *
 * Served by `src/main/ipc/modules/settings.ts`.
 *
 * API keys are held per provider so that configuring a second provider never
 * means re-typing the first one, and so that adding a provider is a change to
 * the catalog in `shared/ai/providers.ts` rather than a change to this
 * contract. The renderer is never given a key: `SettingsView` carries only
 * whether one is configured plus a four-character hint.
 */

import type { AiProviderId } from '../ai/providers'

export interface AppSettings {
  /** The provider used for AI-assisted work. */
  provider: AiProviderId
  /**
   * API keys by provider id. Stored in Electron's userData directory, never in
   * the analyzed project, and never sent to the renderer.
   */
  apiKeys: Record<AiProviderId, string>
  model: string
  /** `low` | `medium` | `high` | `xhigh` | `max` */
  effort: string
  /** Default: analyze with AI assistance when a key is present. */
  aiAssistAnalysis: boolean
  maxAiFileReads: number
}

/**
 * What the renderer may send. `apiKey` sets the key for `provider` when one is
 * given in the same patch, otherwise for the provider already selected — which
 * is what the settings dialog wants, and keeps callers from having to assemble
 * a whole `apiKeys` map to change one key.
 */
export interface SettingsPatch {
  provider?: AiProviderId
  apiKey?: string
  /** Set keys for several providers at once. Merged over the stored map. */
  apiKeys?: Record<AiProviderId, string>
  model?: string
  effort?: string
  aiAssistAnalysis?: boolean
  maxAiFileReads?: number
}

export interface ProviderKeyStatus {
  /** Whether a key is configured. The key itself is never sent. */
  hasApiKey: boolean
  /** Last 4 characters, for display only. */
  apiKeyHint: string
  /** `true` when the key came from the provider's environment variable. */
  fromEnvironment: boolean
}

export interface SettingsView {
  provider: AiProviderId
  model: string
  effort: string
  aiAssistAnalysis: boolean
  maxAiFileReads: number
  /** Key status for every provider in the catalog, by id. */
  providers: Record<AiProviderId, ProviderKeyStatus>
  /** Key status for the selected provider, hoisted for convenience. */
  hasApiKey: boolean
  apiKeyHint: string
  /** `true` when no OS keychain is available and keys are stored in plain text. */
  storesKeysInPlainText: boolean
}

export interface ApiKeyTestResult {
  ok: boolean
  message: string
}

export interface SettingsApi {
  getSettings(): Promise<SettingsView>
  setSettings(patch: SettingsPatch): Promise<SettingsView>
  /** Sends the smallest possible request, to check the stored key works. */
  testApiKey(provider?: AiProviderId): Promise<ApiKeyTestResult>
}
