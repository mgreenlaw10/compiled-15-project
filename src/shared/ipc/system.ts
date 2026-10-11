/**
 * Shell-level operations: directory pickers, revealing files, cancelling work,
 * and the log stream.
 *
 * Served by `src/main/ipc/modules/system.ts`.
 */

import type { LogEvent } from './log'

export interface AppInfo {
  version: string
  electron: string
  node: string
}

export interface SystemApi {
  chooseOutputDirectory(): Promise<{ canceled: boolean; path: string | null }>
  revealInFolder(target: string): Promise<void>

  /** Subscribe to backend log/progress events. Returns an unsubscribe fn. */
  onLog(listener: (event: LogEvent) => void): () => void
  cancelWork(): Promise<void>
  getAppInfo(): Promise<AppInfo>
}
