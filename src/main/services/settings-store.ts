/**
 * Application settings, stored in Electron's per-user data directory.
 *
 * API keys never go near the analyzed project — they would end up in the user's
 * git history — and they are encrypted with the OS keychain through
 * `safeStorage` when that is available. When it is not (some Linux setups
 * without a keyring), keys are stored in plain text and the store says so, so
 * the UI can tell the user rather than quietly pretending otherwise.
 *
 * Keys are held per provider, so configuring a second provider never means
 * re-typing the first, and so adding a provider is a change to the catalog in
 * `shared/ai/providers.ts` rather than a change to this file.
 *
 * The renderer is never given a key: `toView()` returns only whether one is
 * configured, plus a four-character hint.
 */

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  AppSettings,
  ProviderKeyStatus,
  SettingsPatch,
  SettingsView
} from '../../shared/ipc'
import {
  AI_PROVIDERS,
  DEFAULT_EFFORT,
  DEFAULT_MAX_FILE_READS,
  DEFAULT_PROVIDER_ID,
  isKnownProvider,
  providerOrDefault,
  type AiProviderId
} from '../../shared/ai'

interface StoredSettings {
  schemaVersion: number
  provider?: string
  /** Base64 of each encrypted key, by provider id, when encryption works. */
  apiKeysEncrypted?: Record<string, string>
  /** Plain-text keys by provider id, only when encryption is unavailable. */
  apiKeysPlain?: Record<string, string>
  model?: string
  effort?: string
  aiAssistAnalysis?: boolean
  maxAiFileReads?: number

  // --- schema 1, read for migration only -------------------------------
  /** Single Anthropic key, from before provider support. */
  apiKeyEncrypted?: string
  apiKeyPlain?: string
}

const SCHEMA_VERSION = 2

function defaults(): AppSettings {
  const provider = providerOrDefault(DEFAULT_PROVIDER_ID)
  return {
    provider: provider.id,
    apiKeys: {},
    model: provider.defaultModel,
    effort: provider.defaultEffort,
    aiAssistAnalysis: true,
    maxAiFileReads: DEFAULT_MAX_FILE_READS
  }
}

export const DEFAULT_SETTINGS: AppSettings = defaults()

export class SettingsStore {
  private cache: AppSettings | null = null
  private encryptionAvailable: boolean | null = null
  /** Provider ids whose key came from the environment rather than the file. */
  private fromEnvironment = new Set<AiProviderId>()

  constructor(private readonly filePath: string) {}

  static create(): SettingsStore {
    return new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
  }

  private canEncrypt(): boolean {
    if (this.encryptionAvailable === null) {
      try {
        this.encryptionAvailable = safeStorage.isEncryptionAvailable()
      } catch {
        this.encryptionAvailable = false
      }
    }
    return this.encryptionAvailable
  }

  private decrypt(value: string): string {
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return ''
    }
  }

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache

    let stored: Partial<StoredSettings> = {}
    try {
      stored = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as StoredSettings
    } catch {
      // No settings yet, or a corrupt file: start from the defaults rather
      // than failing to launch.
    }

    const base = defaults()
    const apiKeys: Record<AiProviderId, string> = {}

    if (this.canEncrypt()) {
      for (const [id, value] of Object.entries(stored.apiKeysEncrypted ?? {})) {
        const key = this.decrypt(value)
        if (key !== '') apiKeys[id] = key
      }
    }
    for (const [id, value] of Object.entries(stored.apiKeysPlain ?? {})) {
      if (apiKeys[id] === undefined && value !== '') apiKeys[id] = value
    }

    // Schema 1 held a single Anthropic key. Carry it over so upgrading does
    // not silently log the user out of their own provider.
    if (apiKeys[DEFAULT_PROVIDER_ID] === undefined) {
      const legacy =
        stored.apiKeyEncrypted && this.canEncrypt()
          ? this.decrypt(stored.apiKeyEncrypted)
          : (stored.apiKeyPlain ?? '')
      if (legacy !== '') apiKeys[DEFAULT_PROVIDER_ID] = legacy
    }

    // An environment variable is a fallback, never a stored value: it is not
    // written back, and the view reports where the key came from.
    this.fromEnvironment.clear()
    for (const provider of AI_PROVIDERS) {
      if (apiKeys[provider.id] !== undefined) continue
      const fromEnv = process.env[provider.envVar]?.trim()
      if (fromEnv) {
        apiKeys[provider.id] = fromEnv
        this.fromEnvironment.add(provider.id)
      }
    }

    const provider = isKnownProvider(stored.provider)
      ? stored.provider
      : base.provider

    this.cache = {
      provider,
      apiKeys,
      model: stored.model ?? providerOrDefault(provider).defaultModel,
      effort: stored.effort ?? DEFAULT_EFFORT,
      aiAssistAnalysis: stored.aiAssistAnalysis ?? base.aiAssistAnalysis,
      maxAiFileReads: stored.maxAiFileReads ?? base.maxAiFileReads
    }
    return this.cache
  }

  async save(patch: SettingsPatch): Promise<AppSettings> {
    const current = await this.load()

    const provider = isKnownProvider(patch.provider)
      ? patch.provider
      : current.provider

    const apiKeys: Record<AiProviderId, string> = {
      ...current.apiKeys,
      ...(patch.apiKeys ?? {})
    }
    // A bare `apiKey` means "the key for the provider this patch selects",
    // which is what the settings dialog sends.
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
      apiKeys[provider] = patch.apiKey.trim()
      this.fromEnvironment.delete(provider)
    }
    for (const id of Object.keys(patch.apiKeys ?? {})) {
      this.fromEnvironment.delete(id)
    }

    const next: AppSettings = {
      provider,
      apiKeys,
      model: patch.model ?? current.model,
      effort: patch.effort ?? current.effort,
      aiAssistAnalysis: patch.aiAssistAnalysis ?? current.aiAssistAnalysis,
      maxAiFileReads: patch.maxAiFileReads ?? current.maxAiFileReads
    }
    this.cache = next

    const stored: StoredSettings = {
      schemaVersion: SCHEMA_VERSION,
      provider: next.provider,
      model: next.model,
      effort: next.effort,
      aiAssistAnalysis: next.aiAssistAnalysis,
      maxAiFileReads: next.maxAiFileReads
    }

    // Keys that came from the environment are not written back: the user did
    // not put them here, and persisting them would outlive the variable.
    const persistable = Object.entries(next.apiKeys).filter(
      ([id, key]) => key.trim() !== '' && !this.fromEnvironment.has(id)
    )
    if (persistable.length > 0) {
      if (this.canEncrypt()) {
        stored.apiKeysEncrypted = Object.fromEntries(
          persistable.map(([id, key]) => [
            id,
            safeStorage.encryptString(key).toString('base64')
          ])
        )
      } else {
        stored.apiKeysPlain = Object.fromEntries(persistable)
      }
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(
      this.filePath,
      `${JSON.stringify(stored, null, 2)}\n`,
      'utf8'
    )
    return next
  }

  /** The renderer-safe projection: never includes a key itself. */
  async toView(): Promise<SettingsView> {
    const settings = await this.load()

    const providers: Record<AiProviderId, ProviderKeyStatus> = {}
    for (const provider of AI_PROVIDERS) {
      const key = (settings.apiKeys[provider.id] ?? '').trim()
      providers[provider.id] = {
        hasApiKey: key !== '',
        apiKeyHint: key === '' ? '' : `…${key.slice(-4)}`,
        fromEnvironment: this.fromEnvironment.has(provider.id)
      }
    }
    const active = providers[settings.provider] ?? {
      hasApiKey: false,
      apiKeyHint: '',
      fromEnvironment: false
    }

    return {
      provider: settings.provider,
      model: settings.model,
      effort: settings.effort,
      aiAssistAnalysis: settings.aiAssistAnalysis,
      maxAiFileReads: settings.maxAiFileReads,
      providers,
      hasApiKey: active.hasApiKey,
      apiKeyHint: active.apiKeyHint,
      storesKeysInPlainText: !this.canEncrypt()
    }
  }

  /** `true` when keys are stored unencrypted, for an honest warning in the UI. */
  get storesKeyInPlainText(): boolean {
    return !this.canEncrypt()
  }

  get location(): string {
    return this.filePath
  }
}
