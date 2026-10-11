/**
 * Log and progress events.
 *
 * Shared because the backend produces them and the renderer's bottom panel
 * consumes them; kept in their own module because nearly everything imports
 * them and almost nothing needs the rest of the IPC contract.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success'

/**
 * Where an event came from. Add a channel here when a new backend subsystem
 * starts logging — the bottom panel filters on it.
 */
export type LogChannel =
  | 'analysis'
  | 'ai'
  | 'generation'
  | 'validation'
  | 'collab'
  | 'app'

export interface LogEvent {
  id: string
  at: string
  level: LogLevel
  channel: LogChannel
  message: string
  /** 0..1 progress for long-running work, when known. */
  progress?: number
  detail?: string
}
