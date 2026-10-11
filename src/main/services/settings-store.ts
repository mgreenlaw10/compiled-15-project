/**
 * Application settings, stored in Electron's per-user data directory.
 *
 * The API key never goes near the analyzed project — it would end up in the
 * user's git history — and it is encrypted with the OS keychain through
 * `safeStorage` when that is available. When it is not (some Linux setups
 * without a keyring), the key is stored in plain text and the store says so,
 * so the UI can tell the user rather than quietly pretending otherwise.
 *
 * The renderer is never given the key: `toView()` returns only whether one is
 * configured, plus a four-character hint.
 */

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { AppSettings, SettingsView } from '../../shared/types/ipc'
import { DEFAULT_AI_CONFIG } from '../../shared/types/ai'

interface StoredSettings {
  schemaVersion: number
  /** Base64 of the encrypted key, when encryption is available. */
  apiKeyEncrypted?: string
  /** Plain-text key, only used when encryption is unavailable. */
  apiKeyPlain?: string
  model: string
  effort: string
  aiAssistAnalysis: boolean
  maxAiFileReads: number
}

const SCHEMA_VERSION = 1

const DEFAULTS: AppSettings = {
  apiKey: '',
  model: DEFAULT_AI_CONFIG.model,
  effort: DEFAULT_AI_CONFIG.effort,
  aiAssistAnalysis: true,
  maxAiFileReads: DEFAULT_AI_CONFIG.maxFileReads
}

export class SettingsStore {
  private cache: AppSettings | null = null
  private encryptionAvailable: boolean | null = null

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

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache

    let stored: Partial<StoredSettings> = {}
    try {
      stored = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as StoredSettings
    } catch {
      // No settings yet, or a corrupt file: start from the defaults rather
      // than failing to launch.
    }

    let apiKey = ''
    if (stored.apiKeyEncrypted && this.canEncrypt()) {
      try {
        apiKey = safeStorage.decryptString(
          Buffer.from(stored.apiKeyEncrypted, 'base64')
        )
      } catch {
        apiKey = ''
      }
    } else if (stored.apiKeyPlain) {
      apiKey = stored.apiKeyPlain
    }

    this.cache = {
      apiKey,
      model: stored.model ?? DEFAULTS.model,
      effort: stored.effort ?? DEFAULTS.effort,
      aiAssistAnalysis: stored.aiAssistAnalysis ?? DEFAULTS.aiAssistAnalysis,
      maxAiFileReads: stored.maxAiFileReads ?? DEFAULTS.maxAiFileReads
    }
    return this.cache
  }

  async save(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load()
    const next: AppSettings = { ...current, ...patch }
    this.cache = next

    const stored: StoredSettings = {
      schemaVersion: SCHEMA_VERSION,
      model: next.model,
      effort: next.effort,
      aiAssistAnalysis: next.aiAssistAnalysis,
      maxAiFileReads: next.maxAiFileReads
    }
    if (next.apiKey.trim() !== '') {
      if (this.canEncrypt()) {
        stored.apiKeyEncrypted = safeStorage
          .encryptString(next.apiKey)
          .toString('base64')
      } else {
        stored.apiKeyPlain = next.apiKey
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

  /** The renderer-safe projection: never includes the key itself. */
  async toView(): Promise<SettingsView> {
    const settings = await this.load()
    const key = settings.apiKey.trim()
    return {
      model: settings.model,
      effort: settings.effort,
      aiAssistAnalysis: settings.aiAssistAnalysis,
      maxAiFileReads: settings.maxAiFileReads,
      hasApiKey: key !== '',
      apiKeyHint: key === '' ? '' : `…${key.slice(-4)}`
    }
  }

  /** `true` when the key is stored unencrypted, for an honest warning in the UI. */
  get storesKeyInPlainText(): boolean {
    return !this.canEncrypt()
  }

  get location(): string {
    return this.filePath
  }
}
