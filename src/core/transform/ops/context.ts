/**
 * What an operation executor is given, and what it must report back.
 *
 * Each executor is a plain function of this context. It may only touch the
 * virtual workspace, and it must describe its own outcome honestly — including
 * saying "I did not do this" (`unsupported`) or "I did part of this"
 * (`partial`). The engine never infers success from the absence of an
 * exception.
 */

import type { ArchitectureGraph } from '../../../shared/types/architecture'
import type { GraphOperation } from '../../../shared/types/operations'
import type { OperationOutcomeStatus } from '../../../shared/types/generation'
import type { ChannelLogger } from '../../logger'
import type { VirtualWorkspace } from '../workspace'

export interface OpContext {
  workspace: VirtualWorkspace
  /** The architecture as it stands before this operation is executed. */
  graph: ArchitectureGraph
  /** The architecture after the reducer has applied this operation. */
  nextGraph: ArchitectureGraph
  log: ChannelLogger
}

export interface OpResult {
  status: OperationOutcomeStatus
  message: string
  executor: 'deterministic' | 'ai' | 'none'
  touchedPaths: string[]
  warnings: string[]
  /** Risks worth putting in front of the user before anything is written. */
  breakingChanges?: string[]
}

export type OpExecutor<T extends GraphOperation = GraphOperation> = (
  op: T,
  ctx: OpContext
) => OpResult

export function ok(
  message: string,
  touchedPaths: string[],
  extra: Partial<OpResult> = {}
): OpResult {
  return {
    status: 'applied',
    message,
    executor: 'deterministic',
    touchedPaths: [...new Set(touchedPaths)].sort(),
    warnings: [],
    ...extra
  }
}

export function metadataOnly(message: string): OpResult {
  return {
    status: 'metadata_only',
    message,
    executor: 'none',
    touchedPaths: [],
    warnings: []
  }
}

export function unsupported(
  message: string,
  extra: Partial<OpResult> = {}
): OpResult {
  return {
    status: 'unsupported',
    message,
    executor: 'none',
    touchedPaths: [],
    warnings: [],
    ...extra
  }
}

export function failed(message: string): OpResult {
  return {
    status: 'failed',
    message,
    executor: 'deterministic',
    touchedPaths: [],
    warnings: []
  }
}

export { OPERATION_LABELS } from '../../../shared/types/operations'
