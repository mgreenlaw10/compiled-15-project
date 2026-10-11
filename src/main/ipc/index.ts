/**
 * IPC registration: the one place where the GUI meets the backend.
 *
 * This file does registration and error handling only. The handlers themselves
 * live in `./modules`, one file per domain, and every one of them is a thin
 * adapter — validate the arguments, call into `CartographService`, forward log
 * events to the window. No analysis, transformation or filesystem logic lives
 * in the IPC layer at all, which is what keeps the backend usable from a test
 * or a future server with no Electron.
 */

import { ipcMain, type BrowserWindow } from 'electron'

import { COLLAB_CHANNELS, IPC, type LogEvent } from '../../shared/ipc'
import type { ArchitectureGraph } from '../../shared/types/architecture'
import { createLogger, type Logger } from '../../core/logger'
import { createService, type CartographService } from '../../core/pipeline'
import { activeAiConfig } from '../services/ai-config'
import { CollabService } from '../services/collab-service'
import type { SettingsStore } from '../services/settings-store'
import { WorkController, type HandlerContext, type HandlerMap } from './context'
import { HANDLER_MODULES } from './modules'

export type { HandlerContext, HandlerModule } from './context'

export interface RegisterOptions {
  settings: SettingsStore
  getWindow: () => BrowserWindow | null
  /** Electron's userData directory, for the per-install collaboration identity. */
  userDataDir: string
}

export function registerHandlers(options: RegisterOptions): () => void {
  const work = new WorkController()

  /** Logger that mirrors every event into the renderer's bottom panel. */
  const logger: Logger = createLogger((event: LogEvent) => {
    const win = options.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.logEvent, event)
    }
  })

  const getAiConfig = async () => activeAiConfig(await options.settings.load())

  const service: CartographService = createService({
    logger,
    signal: () => work.signal,
    getAiConfig
  })

  // The last graph the analyzer produced. Collaboration reads it to brief
  // agents and to explain conflicts in architectural terms; caching it here
  // avoids making the renderer ship a graph with every collaboration call.
  let lastGraph: ArchitectureGraph | null = null
  const getGraph = (): ArchitectureGraph | null => lastGraph

  const collab = new CollabService({
    logger,
    userDataDir: options.userDataDir,
    getAiConfig,
    getGraph,
    onChanged: (snapshot) => {
      const win = options.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(COLLAB_CHANNELS.collabChanged, snapshot)
      }
    }
  })

  const ctx: HandlerContext = {
    settings: options.settings,
    getWindow: options.getWindow,
    service,
    logger,
    log: logger.child('app'),
    work,
    getAiConfig,
    collab,
    getGraph
  }

  const maps = HANDLER_MODULES.map((module) => module(ctx))
  const handlers: HandlerMap = Object.assign({}, ...maps)

  // A channel registered by two modules would mean one silently shadowing the
  // other, so it is caught here rather than going unnoticed at runtime.
  const registered = maps.flatMap((map) => Object.keys(map))
  const duplicates = registered.filter(
    (channel, index) => registered.indexOf(channel) !== index
  )
  if (duplicates.length > 0) {
    throw new Error(
      `Two IPC handler modules registered the same channel(s): ${[
        ...new Set(duplicates)
      ].join(', ')}`
    )
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

  // Analysis results flow through this handler, so the cache is kept where the
  // result already passes rather than adding a channel for it.
  const analyzeChannel = IPC.analyze
  const originalAnalyze = handlers[analyzeChannel] as
    | ((...args: unknown[]) => Promise<{ graph: ArchitectureGraph }>)
    | undefined
  if (originalAnalyze) {
    handlers[analyzeChannel] = (async (...args: unknown[]) => {
      const result = await originalAnalyze(...args)
      lastGraph = result.graph
      return result
    }) as never
  }

  return () => {
    for (const channel of Object.keys(handlers)) {
      ipcMain.removeHandler(channel)
    }
    work.cancel()
    void collab.disconnect()
  }
}
