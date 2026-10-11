/**
 * Progress + diagnostics channel for the backend.
 *
 * The engine never writes to stdout directly: everything goes through a
 * `Logger` the caller supplies. In the app the main process forwards these
 * events to the renderer's bottom panel over IPC; in tests they are collected
 * in an array; and a future server backend can stream them to a remote client.
 * No global state, so two analyses can run side by side.
 */

import type { LogChannel, LogEvent, LogLevel } from '../shared/types/ipc'

export interface Logger {
  log(
    level: LogLevel,
    channel: LogChannel,
    message: string,
    extra?: { progress?: number; detail?: string }
  ): void
  child(channel: LogChannel): ChannelLogger
}

export interface ChannelLogger {
  debug(message: string, detail?: string): void
  info(message: string, detail?: string): void
  warn(message: string, detail?: string): void
  error(message: string, detail?: string): void
  success(message: string, detail?: string): void
  progress(message: string, fraction: number): void
}

let sequence = 0

function nextId(): string {
  sequence += 1
  return `log_${Date.now().toString(36)}_${sequence.toString(36)}`
}

export function createLogger(sink: (event: LogEvent) => void): Logger {
  const log: Logger['log'] = (level, channel, message, extra) => {
    sink({
      id: nextId(),
      at: new Date().toISOString(),
      level,
      channel,
      message,
      ...(extra?.progress !== undefined ? { progress: extra.progress } : {}),
      ...(extra?.detail !== undefined ? { detail: extra.detail } : {})
    })
  }

  return {
    log,
    child(channel) {
      return {
        debug: (m, d) => log('debug', channel, m, { detail: d }),
        info: (m, d) => log('info', channel, m, { detail: d }),
        warn: (m, d) => log('warn', channel, m, { detail: d }),
        error: (m, d) => log('error', channel, m, { detail: d }),
        success: (m, d) => log('success', channel, m, { detail: d }),
        progress: (m, fraction) =>
          log('info', channel, m, { progress: Math.min(1, Math.max(0, fraction)) })
      }
    }
  }
}

/** A logger that drops everything. Handy in tests and for optional paths. */
export const silentLogger: Logger = createLogger(() => {})

/** Collects events for assertions. */
export function createCollectingLogger(): {
  logger: Logger
  events: LogEvent[]
} {
  const events: LogEvent[] = []
  return { logger: createLogger((e) => events.push(e)), events }
}
