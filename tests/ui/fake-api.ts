/**
 * A fake backend for the UI tests.
 *
 * It implements the real `CartographApi` contract, but backs it with the *real*
 * analyzer and transformation engine running in-process against the sample
 * project. So these tests exercise the actual pipeline through the actual UI
 * surface — only Electron's IPC hop and the dialogs are stubbed.
 */

import path from 'node:path'

import { analyzeProject, readProjectInfo } from '../../src/core/analyzer'
import { createService } from '../../src/core/pipeline'
import { createLogger } from '../../src/core/logger'
import type {
  CartographApi,
  LogEvent,
  SettingsView
} from '../../src/shared/ipc'
import { DEFAULT_PROVIDER_ID } from '../../src/shared/ai'

export const SAMPLE_PROJECT = path.resolve(__dirname, '../../sample-project')

export interface FakeApiOptions {
  /** Directory the picker returns; `null` means the user cancelled. */
  projectToOpen?: string | null
  hasApiKey?: boolean
  outputDirectory?: string | null
}

export interface FakeApi {
  api: CartographApi
  logs: LogEvent[]
  calls: { method: string; args: unknown[] }[]
  settings: SettingsView
}

export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const logs: LogEvent[] = []
  const calls: { method: string; args: unknown[] }[] = []
  const listeners = new Set<(event: LogEvent) => void>()

  const logger = createLogger((event) => {
    logs.push(event)
    for (const listener of listeners) listener(event)
  })
  const service = createService({ logger })

  const hasKey = options.hasApiKey ?? false
  const settings: SettingsView = {
    provider: DEFAULT_PROVIDER_ID,
    model: 'claude-opus-5-5',
    effort: 'high',
    aiAssistAnalysis: false,
    maxAiFileReads: 40,
    providers: {
      [DEFAULT_PROVIDER_ID]: {
        hasApiKey: hasKey,
        apiKeyHint: hasKey ? '…abcd' : '',
        fromEnvironment: false
      }
    },
    hasApiKey: hasKey,
    apiKeyHint: hasKey ? '…abcd' : '',
    storesKeysInPlainText: false
  }

  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args })
  }

  const api: CartographApi = {
    async openProject() {
      record('openProject')
      const root = options.projectToOpen ?? SAMPLE_PROJECT
      if (root === null) return { canceled: true, project: null }
      return { canceled: false, project: await readProjectInfo(root) }
    },

    async openProjectAt(root) {
      record('openProjectAt', root)
      return { canceled: false, project: await readProjectInfo(root) }
    },

    async analyze(root, analyzeOptions) {
      record('analyze', root, analyzeOptions)
      const result = await analyzeProject(root, { logger })
      return {
        project: result.project,
        graph: result.graph,
        layout: result.layout,
        fileTree: result.fileTree,
        savedDocument: null
      }
    },

    async loadDocument() {
      return null
    },

    async saveDocument(req) {
      record('saveDocument', req)
      return { path: path.join(req.document.projectRoot, '.cartograph/architecture.cartograph.json') }
    },

    async readProjectFile(_root, relPath) {
      return { path: relPath, content: '', truncated: false }
    },

    async planChanges(root, req) {
      record('planChanges', root, req)
      return service.plan({
        projectRoot: root,
        graph: req.graph,
        operations: req.operations,
        useAi: req.useAi
      })
    },

    async previewDiff(changeSet) {
      record('previewDiff')
      return service.previewDiff(changeSet)
    },

    async applyChanges(root, req) {
      record('applyChanges', root, req)
      return service.apply({
        projectRoot: root,
        changeSet: req.changeSet,
        mode: req.mode,
        outputDirectory: req.outputDirectory,
        createBackup: req.createBackup,
        validate: req.validate
      })
    },

    async validateProject(root) {
      record('validateProject', root)
      return service.validate(root)
    },

    async chooseOutputDirectory() {
      record('chooseOutputDirectory')
      const out = options.outputDirectory ?? null
      return out === null
        ? { canceled: true, path: null }
        : { canceled: false, path: out }
    },

    async revealInFolder(target) {
      record('revealInFolder', target)
    },

    async getSettings() {
      return { ...settings }
    },

    async setSettings(patch) {
      record('setSettings', patch)
      const provider = patch.provider ?? settings.provider
      settings.provider = provider
      if (typeof patch.apiKey === 'string' && patch.apiKey !== '') {
        const status = {
          hasApiKey: true,
          apiKeyHint: `…${patch.apiKey.slice(-4)}`,
          fromEnvironment: false
        }
        settings.providers = { ...settings.providers, [provider]: status }
        settings.hasApiKey = status.hasApiKey
        settings.apiKeyHint = status.apiKeyHint
      }
      if (patch.model) settings.model = patch.model
      if (patch.effort) settings.effort = patch.effort
      if (typeof patch.aiAssistAnalysis === 'boolean') {
        settings.aiAssistAnalysis = patch.aiAssistAnalysis
      }
      return { ...settings }
    },

    async testApiKey(provider) {
      const id = provider ?? settings.provider
      return {
        ok: settings.providers[id]?.hasApiKey === true,
        message: 'fake'
      }
    },

    onLog(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async cancelWork() {
      record('cancelWork')
    },

    async getAppInfo() {
      return { version: 'test', electron: 'test', node: process.versions.node }
    }
  }

  return { api, logs, calls, settings }
}

/** Installs the fake API on `window`, as the preload script would. */
export function installFakeApi(options: FakeApiOptions = {}): FakeApi {
  const fake = createFakeApi(options)
  ;(window as unknown as { cartograph: CartographApi }).cartograph = fake.api
  return fake
}
