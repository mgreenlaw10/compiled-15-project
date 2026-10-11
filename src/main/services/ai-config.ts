/**
 * Turning stored settings into a model configuration.
 *
 * One place does this so the IPC layer, the pipeline and the "test this key"
 * button cannot disagree about which key and model a provider gets.
 */

import type { AppSettings } from '../../shared/ipc'
import {
  DEFAULT_EFFORT,
  DEFAULT_MAX_FILE_READS,
  providerOrDefault,
  type AiConfig,
  type AiProviderId,
  type Effort
} from '../../shared/ai'

/**
 * The configuration for one provider, whether or not a key is stored for it.
 * Callers that need a usable client check `isConfigured` first.
 */
export function aiConfigFor(
  settings: AppSettings,
  providerId: AiProviderId = settings.provider
): AiConfig {
  const descriptor = providerOrDefault(providerId)
  // The stored model belongs to the selected provider; asking about a
  // different one falls back to that provider's own default rather than
  // sending, say, a Claude model name to someone else.
  const model =
    providerId === settings.provider && settings.model.trim() !== ''
      ? settings.model
      : descriptor.defaultModel

  return {
    provider: descriptor.id,
    apiKey: settings.apiKeys[descriptor.id] ?? '',
    model,
    effort: (settings.effort as Effort) || DEFAULT_EFFORT,
    maxFileReads: settings.maxAiFileReads ?? DEFAULT_MAX_FILE_READS
  }
}

/** The active provider's configuration, or `null` when it has no key. */
export function activeAiConfig(settings: AppSettings): AiConfig | null {
  const config = aiConfigFor(settings)
  return config.apiKey.trim() === '' ? null : config
}
