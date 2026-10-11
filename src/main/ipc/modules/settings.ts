/**
 * Settings, and checking that a provider key works.
 *
 * Validation here is deliberately shaped by the provider catalog rather than
 * by a list of field names: adding a provider means adding a descriptor in
 * `shared/ai/providers.ts`, not editing this file.
 */

import { SETTINGS_CHANNELS } from '../../../shared/ipc'
import type {
  ApiKeyTestResult,
  SettingsPatch,
  SettingsView
} from '../../../shared/ipc'
import {
  EFFORT_LEVELS,
  isKnownProvider,
  type AiProviderId
} from '../../../shared/ai'
import { testApiKey } from '../../../core/ai/client'
import { aiConfigFor } from '../../services/ai-config'
import type { HandlerModule } from '../context'

const MIN_FILE_READS = 1
const MAX_FILE_READS = 500

/** Keeps anything the renderer sends within what the backend can honour. */
function sanitize(incoming: SettingsPatch): SettingsPatch {
  const clean: SettingsPatch = {}

  if (isKnownProvider(incoming.provider)) clean.provider = incoming.provider
  if (typeof incoming.apiKey === 'string') clean.apiKey = incoming.apiKey.trim()

  if (incoming.apiKeys && typeof incoming.apiKeys === 'object') {
    const keys: Record<AiProviderId, string> = {}
    for (const [id, value] of Object.entries(incoming.apiKeys)) {
      if (isKnownProvider(id) && typeof value === 'string') {
        keys[id] = value.trim()
      }
    }
    if (Object.keys(keys).length > 0) clean.apiKeys = keys
  }

  if (typeof incoming.model === 'string' && incoming.model.trim() !== '') {
    clean.model = incoming.model.trim()
  }
  if (
    typeof incoming.effort === 'string' &&
    (EFFORT_LEVELS as readonly string[]).includes(incoming.effort)
  ) {
    clean.effort = incoming.effort
  }
  if (typeof incoming.aiAssistAnalysis === 'boolean') {
    clean.aiAssistAnalysis = incoming.aiAssistAnalysis
  }
  if (typeof incoming.maxAiFileReads === 'number') {
    clean.maxAiFileReads = Math.max(
      MIN_FILE_READS,
      Math.min(MAX_FILE_READS, Math.round(incoming.maxAiFileReads))
    )
  }
  return clean
}

export const settingsHandlers: HandlerModule = (ctx) => ({
  [SETTINGS_CHANNELS.getSettings]: async (): Promise<SettingsView> =>
    ctx.settings.toView(),

  [SETTINGS_CHANNELS.setSettings]: async (
    _e: unknown,
    patch: unknown
  ): Promise<SettingsView> => {
    const clean = sanitize((patch ?? {}) as SettingsPatch)
    await ctx.settings.save(clean)

    const setAKey =
      clean.apiKey !== undefined || clean.apiKeys !== undefined
    if (setAKey && ctx.settings.storesKeyInPlainText) {
      ctx.log.warn(
        'This system has no OS keychain available, so API keys are stored unencrypted in the Cartograph settings file.',
        ctx.settings.location
      )
    }
    return ctx.settings.toView()
  },

  [SETTINGS_CHANNELS.testApiKey]: async (
    _e: unknown,
    provider: unknown
  ): Promise<ApiKeyTestResult> => {
    const settings = await ctx.settings.load()
    const target = isKnownProvider(provider) ? provider : settings.provider
    return testApiKey(aiConfigFor(settings, target))
  }
})
