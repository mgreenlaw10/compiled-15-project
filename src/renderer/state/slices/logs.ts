/**
 * The activity log.
 *
 * Backend events arrive over IPC; UI-side events are created with `uiLog` so
 * that a graph edit and an analysis step read the same way in the panel.
 */

import type { LogEvent } from '../../../shared/ipc'
import type { LogSlice, Slice } from '../types'

export const MAX_LOGS = 2000

let sequence = 0

/** A log event originating in the renderer rather than the backend. */
export function uiLog(
  level: LogEvent['level'],
  channel: LogEvent['channel'],
  message: string,
  detail?: string
): LogEvent {
  sequence += 1
  return {
    id: `ui_${Date.now().toString(36)}_${sequence}`,
    at: new Date().toISOString(),
    level,
    channel,
    message,
    ...(detail ? { detail } : {})
  }
}

export const createLogSlice: Slice<LogSlice> = (set) => ({
  logs: [],

  pushLog(event) {
    set((state) => ({ logs: [...state.logs, event].slice(-MAX_LOGS) }))
  },

  clearLogs() {
    set({ logs: [] })
  }
})
