/**
 * Types describing a planned code change and its outcome.
 *
 * The engine never writes to disk while planning. It produces a `ChangeSet`,
 * which the GUI shows as a preview, and only an explicit user action turns that
 * `ChangeSet` into files. That split is what makes "preview before overwrite"
 * and "generate into a new directory" the same code path.
 */

import type { ArchitectureGraph } from './architecture'
import type { GraphOperation, GraphOperationType } from './operations'

export type FileChangeKind = 'create' | 'modify' | 'delete' | 'rename'

export interface FileChange {
  kind: FileChangeKind
  /** Project-relative POSIX path after the change. */
  path: string
  /** Project-relative POSIX path before the change (rename/delete only). */
  previousPath?: string
  /** Contents before the change; `null` for newly created files. */
  before: string | null
  /** Contents after the change; `null` for deleted files. */
  after: string | null
  /** Which operations contributed to this change. */
  operationIds: string[]
  /** Human-readable reason, shown in the preview. */
  reason: string
}

export type OperationOutcomeStatus =
  | 'applied'
  | 'metadata_only'
  | 'partial'
  | 'unsupported'
  | 'failed'
  | 'skipped'

export interface OperationOutcome {
  operationId: string
  operationType: GraphOperationType
  status: OperationOutcomeStatus
  /** What the engine did, or why it refused. Always user-facing. */
  message: string
  /** Executor that handled it. */
  executor: 'deterministic' | 'ai' | 'none'
  /** Paths touched by this operation. */
  touchedPaths: string[]
  /** Things the user should check manually. */
  warnings: string[]
}

export interface ChangeSet {
  changes: FileChange[]
  outcomes: OperationOutcome[]
  /** Module-level summary for the preview panel. */
  modulesAdded: string[]
  modulesRemoved: string[]
  modulesRenamed: { from: string; to: string }[]
  /** Risks the user should read before applying. */
  breakingChanges: string[]
  /** `true` when at least one operation needed an API key that was absent. */
  aiSkipped: boolean
}

export interface PlanRequest {
  /** The architecture the operations were written against. */
  graph: ArchitectureGraph
  /** Operations to materialize, in order. */
  operations: GraphOperation[]
  /** Allow the AI agent to handle operations the deterministic engine can't. */
  useAi: boolean
}

export type WriteMode = 'new-directory' | 'in-place'

export interface ApplyRequest {
  mode: WriteMode
  /** Required for `new-directory`; absolute path. */
  outputDirectory?: string
  /** For `in-place`: create a restorable backup before writing. */
  createBackup: boolean
  /** Run `tsc` / `npm test` in the written project afterwards. */
  validate: boolean
  changeSet: ChangeSet
}

export interface BackupInfo {
  /** Absolute path of the backup directory. */
  directory: string
  fileCount: number
  /** Git HEAD at the time of the backup, when the project is a git repo. */
  gitHead: string | null
  /** `true` when the repo had uncommitted changes (backup is the only safety net). */
  gitDirty: boolean | null
}

export interface ValidationCheck {
  name: string
  command: string
  status: 'passed' | 'failed' | 'skipped' | 'timeout'
  exitCode: number | null
  durationMs: number
  output: string
  /** Why it was skipped, when applicable. */
  note?: string
}

export interface ValidationReport {
  /** Absolute path of the project that was validated. */
  projectRoot: string
  checks: ValidationCheck[]
  /** `true` only when at least one check ran and none failed. */
  passed: boolean
  summary: string
}

export interface ApplyResult {
  mode: WriteMode
  /** Absolute path of the project that now holds the generated code. */
  outputDirectory: string
  created: string[]
  modified: string[]
  deleted: string[]
  renamed: { from: string; to: string }[]
  backup: BackupInfo | null
  validation: ValidationReport | null
  /** Operation ids whose changes actually reached disk. */
  appliedOperationIds: string[]
  errors: string[]
}
