/**
 * What every IPC handler module is given, and the helpers they share.
 *
 * Arguments arriving over IPC are treated as untrusted input even though they
 * come from our own renderer: paths are checked, and a failure is returned as a
 * rejected promise with a readable message rather than crashing the process.
 */

import type { BrowserWindow } from 'electron'
import path from 'node:path'

import type { AiConfig } from '../../shared/ai'
import type { ChannelLogger, Logger } from '../../core/logger'
import type { CartographService } from '../../core/pipeline'
import type { SettingsStore } from '../services/settings-store'

/** One cancellable unit of work at a time, matching the single-window UI. */
export class WorkController {
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

/**
 * The context handed to each handler module. A module reaches the outside world
 * only through this object, which is what lets the whole IPC layer be exercised
 * without Electron.
 */
export interface HandlerContext {
  settings: SettingsStore
  getWindow: () => BrowserWindow | null
  service: CartographService
  logger: Logger
  /** `logger.child('app')`, for the handler-level messages. */
  log: ChannelLogger
  work: WorkController
  /** The model configuration for the selected provider, or `null` with no key. */
  getAiConfig: () => Promise<AiConfig | null>
}

/** A handler module: channel name -> implementation. */
export type HandlerMap = Record<string, (...args: never[]) => unknown>

export type HandlerModule = (ctx: HandlerContext) => HandlerMap

export function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

/** Rejects a path that tries to read outside the open project. */
export function resolveInsideProject(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, relPath)
  const rel = path.relative(resolvedRoot, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`"${relPath}" is outside the open project`)
  }
  return target
}
