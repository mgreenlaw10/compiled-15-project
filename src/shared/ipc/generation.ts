/**
 * Planning, previewing, writing and validating generated changes.
 *
 * Served by `src/main/ipc/modules/generation.ts`.
 */

import type {
  ApplyRequest,
  ApplyResult,
  ChangeSet,
  PlanRequest,
  ValidationReport
} from '../types/generation'

export interface DiffPreview {
  path: string
  /** Unified diff text. */
  patch: string
  additions: number
  deletions: number
}

export interface GenerationApi {
  planChanges(root: string, req: PlanRequest): Promise<ChangeSet>
  previewDiff(changeSet: ChangeSet): Promise<DiffPreview[]>
  applyChanges(root: string, req: ApplyRequest): Promise<ApplyResult>
  validateProject(root: string): Promise<ValidationReport>
}
