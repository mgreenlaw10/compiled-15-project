/**
 * The renderer <-> main process contract.
 *
 * The renderer never touches the filesystem, ts-morph, or the Anthropic SDK; it
 * only calls these methods. That boundary is what the future "replace the local
 * backend with a shared server" story depends on: `CartographApi` is already an
 * async, serializable, transport-agnostic interface.
 */

import type { ArchitectureGraph, GraphLayout } from './architecture'
import type {
  ApplyRequest,
  ApplyResult,
  ChangeSet,
  PlanRequest,
  ValidationReport
} from './generation'
import type { ArchitectureDocument, FileTreeNode, ProjectInfo } from './project'

export interface AnalyzeOptions {
  /** Let the model write module descriptions and suggest boundaries. */
  useAi: boolean
  /** Extra ignore globs on top of the defaults. */
  extraIgnores?: string[]
}

export interface AnalyzeResult {
  project: ProjectInfo
  graph: ArchitectureGraph
  layout: GraphLayout
  fileTree: FileTreeNode
  /** A saved document found in the project, if any. */
  savedDocument: ArchitectureDocument | null
}

export interface OpenProjectResult {
  canceled: boolean
  project: ProjectInfo | null
}

export interface AppSettings {
  /** Anthropic API key. Stored in Electron's userData dir, never in the project. */
  apiKey: string
  model: string
  /** `low` | `medium` | `high` | `xhigh` | `max` */
  effort: string
  /** Default: analyze with AI assistance when a key is present. */
  aiAssistAnalysis: boolean
  maxAiFileReads: number
}

export interface SettingsView extends Omit<AppSettings, 'apiKey'> {
  /** Whether a key is configured. The key itself is never sent to the renderer. */
  hasApiKey: boolean
  /** Last 4 characters, for display only. */
  apiKeyHint: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success'

export type LogChannel = 'analysis' | 'ai' | 'generation' | 'validation' | 'app'

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

export interface DiffPreview {
  path: string
  /** Unified diff text. */
  patch: string
  additions: number
  deletions: number
}

export interface SaveDocumentRequest {
  document: ArchitectureDocument
}

export interface ReadFileResult {
  path: string
  content: string
  truncated: boolean
}

/** The whole backend surface, as seen by the renderer. */
export interface CartographApi {
  /** Native folder picker. Returns `canceled: true` if dismissed. */
  openProject(): Promise<OpenProjectResult>
  /** Open a specific directory without a dialog (used by tests and recents). */
  openProjectAt(root: string): Promise<OpenProjectResult>
  analyze(root: string, options: AnalyzeOptions): Promise<AnalyzeResult>

  loadDocument(root: string): Promise<ArchitectureDocument | null>
  saveDocument(req: SaveDocumentRequest): Promise<{ path: string }>

  readProjectFile(root: string, relPath: string): Promise<ReadFileResult>

  planChanges(root: string, req: PlanRequest): Promise<ChangeSet>
  previewDiff(changeSet: ChangeSet): Promise<DiffPreview[]>
  applyChanges(root: string, req: ApplyRequest): Promise<ApplyResult>
  validateProject(root: string): Promise<ValidationReport>

  chooseOutputDirectory(): Promise<{ canceled: boolean; path: string | null }>
  revealInFolder(target: string): Promise<void>

  getSettings(): Promise<SettingsView>
  setSettings(patch: Partial<AppSettings>): Promise<SettingsView>
  testApiKey(): Promise<{ ok: boolean; message: string }>

  /** Subscribe to backend log/progress events. Returns an unsubscribe fn. */
  onLog(listener: (event: LogEvent) => void): () => void
  cancelWork(): Promise<void>
  getAppInfo(): Promise<{ version: string; electron: string; node: string }>
}

/** IPC channel names. Kept in one place so main and preload cannot drift. */
export const IPC = {
  openProject: 'cartograph:open-project',
  openProjectAt: 'cartograph:open-project-at',
  analyze: 'cartograph:analyze',
  loadDocument: 'cartograph:load-document',
  saveDocument: 'cartograph:save-document',
  readProjectFile: 'cartograph:read-project-file',
  planChanges: 'cartograph:plan-changes',
  previewDiff: 'cartograph:preview-diff',
  applyChanges: 'cartograph:apply-changes',
  validateProject: 'cartograph:validate-project',
  chooseOutputDirectory: 'cartograph:choose-output-directory',
  revealInFolder: 'cartograph:reveal-in-folder',
  getSettings: 'cartograph:get-settings',
  setSettings: 'cartograph:set-settings',
  testApiKey: 'cartograph:test-api-key',
  cancelWork: 'cartograph:cancel-work',
  getAppInfo: 'cartograph:get-app-info',
  logEvent: 'cartograph:log-event'
} as const
