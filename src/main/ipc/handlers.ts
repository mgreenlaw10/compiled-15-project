/**
 * IPC handlers: the one place where the GUI meets the backend.
 *
 * Every handler is a thin adapter — validate the arguments, call into
 * `CartographService`, forward log events to the window. No analysis,
 * transformation or filesystem logic lives here, which is what keeps the
 * backend usable from a test or a future server with no Electron at all.
 *
 * Arguments arriving over IPC are treated as untrusted input even though they
 * come from our own renderer: paths are checked, and a failure is returned as a
 * rejected promise with a readable message rather than crashing the process.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  AnalyzeOptions,
  AnalyzeResult,
  AppSettings,
  LogEvent,
  OpenProjectResult,
  ReadFileResult,
  SaveDocumentRequest,
  SettingsView
} from '../../shared/types/ipc'
import { IPC } from '../../shared/types/ipc'
import type {
  ApplyRequest,
  ChangeSet,
  PlanRequest
} from '../../shared/types/generation'
import type { ArchitectureDocument, ProjectInfo } from '../../shared/types/project'
import { createLogger, type Logger } from '../../core/logger'
import {
  createService,
  isUsableProjectDirectory,
  type CartographService
} from '../../core/pipeline'
import { readProjectInfo } from '../../core/analyzer'
import { testApiKey } from '../../core/ai/client'
import { DEFAULT_AI_CONFIG, type Effort } from '../../shared/types/ai'
import { loadDocument, saveDocument } from '../services/document-store'
import { SettingsStore } from '../services/settings-store'

const MAX_READ_CHARS = 400_000

export interface HandlerContext {
  settings: SettingsStore
  getWindow: () => BrowserWindow | null
}

/** One cancellable unit of work at a time, matching the single-window UI. */
class WorkController {
  private controller: AbortController | null = null

  begin(): AbortSignal {
    this.cancel()
    this.controller = new AbortController()
    return this.controller.signal
  }

  cancel(): void {
    this.controller?.abort()
    this.controller = null
  }

  get signal(): AbortSignal | undefined {
    return this.controller?.signal
  }
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

/** Rejects a path that tries to read outside the open project. */
function resolveInsideProject(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, relPath)
  const rel = path.relative(resolvedRoot, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`"${relPath}" is outside the open project`)
  }
  return target
}

export function registerHandlers(ctx: HandlerContext): () => void {
  const work = new WorkController()

  /** Logger that mirrors every event into the renderer's bottom panel. */
  const logger: Logger = createLogger((event: LogEvent) => {
    const win = ctx.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.logEvent, event)
    }
  })

  const service: CartographService = createService({
    logger,
    signal: () => work.signal,
    getAiConfig: async () => {
      const settings = await ctx.settings.load()
      if (settings.apiKey.trim() === '') return null
      return {
        apiKey: settings.apiKey,
        model: settings.model || DEFAULT_AI_CONFIG.model,
        effort: (settings.effort as Effort) ?? DEFAULT_AI_CONFIG.effort,
        maxFileReads: settings.maxAiFileReads ?? DEFAULT_AI_CONFIG.maxFileReads
      }
    }
  })

  const app = logger.child('app')

  async function openProjectAt(root: string): Promise<OpenProjectResult> {
    const usable = await isUsableProjectDirectory(root)
    if (!usable.ok) throw new Error(usable.reason ?? 'That directory cannot be opened')
    const project: ProjectInfo = await readProjectInfo(root)
    app.info(`Opened ${project.name}`, root)
    return { canceled: false, project }
  }

  const handlers: Record<string, (...args: never[]) => unknown> = {
    [IPC.openProject]: async (): Promise<OpenProjectResult> => {
      const win = ctx.getWindow()
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: 'Open a project to map',
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: 'Open project'
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, project: null }
      }
      return openProjectAt(result.filePaths[0])
    },

    [IPC.openProjectAt]: async (_e: unknown, root: unknown) =>
      openProjectAt(asString(root, 'root')),

    [IPC.analyze]: async (
      _e: unknown,
      root: unknown,
      options: unknown
    ): Promise<AnalyzeResult> => {
      const projectRoot = asString(root, 'root')
      const opts = (options ?? {}) as AnalyzeOptions
      work.begin()

      const analyzed = await service.analyze(projectRoot, {
        extraIgnores: opts.extraIgnores,
        useAi: opts.useAi === true
      })

      let savedDocument: ArchitectureDocument | null = null
      try {
        savedDocument = await loadDocument(projectRoot)
        if (savedDocument) {
          app.info(
            `Found a saved architecture with ${savedDocument.operations.length} recorded edit(s)`
          )
        }
      } catch (error) {
        app.warn('A saved architecture could not be read', (error as Error).message)
      }

      return {
        project: analyzed.project,
        graph: analyzed.graph,
        layout: analyzed.layout,
        fileTree: analyzed.fileTree,
        savedDocument
      }
    },

    [IPC.loadDocument]: async (_e: unknown, root: unknown) =>
      loadDocument(asString(root, 'root')),

    [IPC.saveDocument]: async (_e: unknown, req: unknown) => {
      const request = req as SaveDocumentRequest
      if (!request?.document?.projectRoot) {
        throw new Error('The document has no project root')
      }
      const saved = await saveDocument(request.document)
      app.success(`Saved the architecture to ${saved.path}`)
      return saved
    },

    [IPC.readProjectFile]: async (
      _e: unknown,
      root: unknown,
      relPath: unknown
    ): Promise<ReadFileResult> => {
      const projectRoot = asString(root, 'root')
      const rel = asString(relPath, 'path')
      const target = resolveInsideProject(projectRoot, rel)
      const content = await fs.readFile(target, 'utf8')
      return {
        path: rel,
        content:
          content.length > MAX_READ_CHARS
            ? content.slice(0, MAX_READ_CHARS)
            : content,
        truncated: content.length > MAX_READ_CHARS
      }
    },

    [IPC.planChanges]: async (_e: unknown, root: unknown, req: unknown) => {
      const projectRoot = asString(root, 'root')
      const request = req as PlanRequest
      if (!Array.isArray(request?.operations)) {
        throw new Error('planChanges needs an operations array')
      }
      if (!request.graph?.modules) {
        throw new Error('planChanges needs the current graph')
      }

      work.begin()
      return service.plan({
        projectRoot,
        graph: request.graph,
        operations: request.operations,
        useAi: request.useAi === true
      })
    },

    [IPC.previewDiff]: async (_e: unknown, changeSet: unknown) => {
      const set = changeSet as ChangeSet
      if (!Array.isArray(set?.changes)) {
        throw new Error('previewDiff needs a change set')
      }
      return service.previewDiff(set)
    },

    [IPC.applyChanges]: async (_e: unknown, root: unknown, req: unknown) => {
      const projectRoot = asString(root, 'root')
      const request = req as ApplyRequest
      if (!request?.changeSet) throw new Error('applyChanges needs a change set')
      if (request.mode !== 'in-place' && request.mode !== 'new-directory') {
        throw new Error(`Unknown write mode "${String(request.mode)}"`)
      }
      work.begin()
      return service.apply({
        projectRoot,
        changeSet: request.changeSet,
        mode: request.mode,
        outputDirectory: request.outputDirectory,
        createBackup: request.createBackup !== false,
        validate: request.validate !== false
      })
    },

    [IPC.validateProject]: async (_e: unknown, root: unknown) => {
      work.begin()
      return service.validate(asString(root, 'root'))
    },

    [IPC.chooseOutputDirectory]: async () => {
      const win = ctx.getWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Choose where to generate the project',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Generate here'
      }
      // Attached to the window when there is one so the dialog is modal.
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, path: null }
      }
      return { canceled: false, path: result.filePaths[0] }
    },

    [IPC.revealInFolder]: async (_e: unknown, target: unknown) => {
      shell.showItemInFolder(asString(target, 'target'))
    },

    [IPC.getSettings]: async (): Promise<SettingsView> => ctx.settings.toView(),

    [IPC.setSettings]: async (_e: unknown, patch: unknown): Promise<SettingsView> => {
      const incoming = (patch ?? {}) as Partial<AppSettings>
      const clean: Partial<AppSettings> = {}
      if (typeof incoming.apiKey === 'string') clean.apiKey = incoming.apiKey.trim()
      if (typeof incoming.model === 'string' && incoming.model.trim() !== '') {
        clean.model = incoming.model.trim()
      }
      if (typeof incoming.effort === 'string') clean.effort = incoming.effort
      if (typeof incoming.aiAssistAnalysis === 'boolean') {
        clean.aiAssistAnalysis = incoming.aiAssistAnalysis
      }
      if (typeof incoming.maxAiFileReads === 'number') {
        clean.maxAiFileReads = Math.max(
          1,
          Math.min(500, Math.round(incoming.maxAiFileReads))
        )
      }
      await ctx.settings.save(clean)
      if (clean.apiKey !== undefined && ctx.settings.storesKeyInPlainText) {
        app.warn(
          'This system has no OS keychain available, so the API key is stored unencrypted in the Cartograph settings file.',
          ctx.settings.location
        )
      }
      return ctx.settings.toView()
    },

    [IPC.testApiKey]: async () => {
      const settings = await ctx.settings.load()
      return testApiKey({
        apiKey: settings.apiKey,
        model: settings.model || DEFAULT_AI_CONFIG.model,
        effort: (settings.effort as Effort) ?? DEFAULT_AI_CONFIG.effort,
        maxFileReads: settings.maxAiFileReads
      })
    },

    [IPC.cancelWork]: async () => {
      work.cancel()
      app.warn('Canceled the running task')
    },

    [IPC.getAppInfo]: async () => ({
      version: process.env.npm_package_version ?? '0.1.0',
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node
    })
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (...args) => {
      try {
        return await (handler as (...a: unknown[]) => unknown)(...args)
      } catch (error) {
        const message = (error as Error).message ?? String(error)
        logger.log('error', 'app', `${channel} failed: ${message}`)
        // Rethrow so the renderer's promise rejects with a useful message
        // instead of the raw "Error invoking remote method" wrapper.
        throw new Error(message)
      }
    })
  }

  return () => {
    for (const channel of Object.keys(handlers)) {
      ipcMain.removeHandler(channel)
    }
    work.cancel()
  }
}
