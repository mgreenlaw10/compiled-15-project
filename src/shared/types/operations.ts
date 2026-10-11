/**
 * Graph operations.
 *
 * Every structural edit to the architecture is expressed as one of these
 * values. They are the unit of:
 *
 *   - undo / redo and the "unapplied changes" indicator in the GUI,
 *   - the diff between the original and the desired architecture,
 *   - the work queue handed to the transformation engine,
 *   - and (later) the messages exchanged between collaborators and AI agents.
 *
 * Because of that last point they are plain serializable JSON, carry the actor
 * that issued them, and record the graph version they were written against so
 * that conflicting concurrent edits can be detected.
 */

import type { DependencyKind, ModuleId, NodePosition } from './architecture'

export interface OperationMeta {
  /** Unique operation id (also used as the idempotency key). */
  id: string
  /** Who issued it: `'user'`, `'ai'`, or a collaborator id in the future. */
  actor: string
  issuedAt: string
  /** `ArchitectureGraph.version` the operation was authored against. */
  baseVersion: number
}

export interface AddModuleOperation {
  type: 'add_module'
  module: {
    id: ModuleId
    name: string
    description: string
    responsibilities: string[]
    /** Directory to create for the module, project-relative POSIX. */
    directory: string | null
    /** Exported symbols the new module should expose. */
    publicInterface: string[]
  }
}

export interface RenameModuleOperation {
  type: 'rename_module'
  moduleId: ModuleId
  name: string
  /**
   * When set, also rename the module's backing directory to this
   * project-relative POSIX path and rewrite every import that points into it.
   */
  directory?: string | null
}

export interface UpdateModuleOperation {
  type: 'update_module'
  moduleId: ModuleId
  description?: string
  responsibilities?: string[]
  publicInterface?: string[]
  tags?: string[]
}

export interface DeleteModuleOperation {
  type: 'delete_module'
  moduleId: ModuleId
  /**
   * What to do with the module's files:
   *  - `reassign`: move them into `reassignTo` (requires `reassignTo`),
   *  - `delete`: delete the files from disk,
   *  - `orphan`: drop the module but leave files where they are (unassigned).
   */
  fileDisposition: 'reassign' | 'delete' | 'orphan'
  reassignTo?: ModuleId
}

export interface MoveFileOperation {
  type: 'move_file'
  /** Project-relative POSIX path of the file to move. */
  file: string
  fromModuleId: ModuleId
  toModuleId: ModuleId
  /**
   * Optional explicit destination path. When omitted the engine places the
   * file in the target module's directory under its current basename.
   */
  toPath?: string
}

export interface MoveSymbolOperation {
  type: 'move_symbol'
  /** Name of an exported declaration. */
  symbol: string
  /** Project-relative POSIX path of the file currently declaring it. */
  fromFile: string
  fromModuleId: ModuleId
  toModuleId: ModuleId
  /** Destination file, project-relative POSIX. Defaults to the target barrel. */
  toFile?: string
  /**
   * When `true` the original file re-exports the moved symbol so existing
   * importers keep working even if one of them could not be rewritten.
   */
  leaveReExport: boolean
}

export interface MoveResponsibilityOperation {
  type: 'move_responsibility'
  /** Free-text responsibility, e.g. "session creation and expiry". */
  responsibility: string
  fromModuleId: ModuleId
  toModuleId: ModuleId
}

export interface AddDependencyOperation {
  type: 'add_dependency'
  from: ModuleId
  to: ModuleId
  kind: DependencyKind
}

export interface RemoveDependencyOperation {
  type: 'remove_dependency'
  from: ModuleId
  to: ModuleId
}

export interface ScaffoldModuleOperation {
  type: 'scaffold_module'
  moduleId: ModuleId
  /** Extra guidance for the AI agent, beyond the module's own description. */
  instructions: string
}

export type GraphOperationBody =
  | AddModuleOperation
  | RenameModuleOperation
  | UpdateModuleOperation
  | DeleteModuleOperation
  | MoveFileOperation
  | MoveSymbolOperation
  | MoveResponsibilityOperation
  | AddDependencyOperation
  | RemoveDependencyOperation
  | ScaffoldModuleOperation

export type GraphOperationType = GraphOperationBody['type']

/** A graph operation with its envelope. This is what gets logged and shipped. */
export type GraphOperation = GraphOperationBody & OperationMeta

/**
 * Visual-only edits. Kept in a separate type from `GraphOperation` precisely so
 * that it is impossible to hand one to the transformation engine by accident.
 */
export type LayoutOperationBody =
  | { type: 'set_position'; moduleId: ModuleId; position: NodePosition }
  | { type: 'set_expanded'; moduleId: ModuleId; expanded: boolean }
  | { type: 'relayout'; positions: Record<ModuleId, NodePosition> }

export type LayoutOperation = LayoutOperationBody & { id: string; actor: string }

/** Operation types that require source code to change to be real. */
export const STRUCTURAL_OPERATIONS: readonly GraphOperationType[] = [
  'add_module',
  'rename_module',
  'delete_module',
  'move_file',
  'move_symbol',
  'move_responsibility',
  'scaffold_module'
]

/**
 * Operation types that only change architectural metadata. They still count as
 * unsaved graph changes, but applying them never rewrites code.
 */
export const METADATA_ONLY_OPERATIONS: readonly GraphOperationType[] = [
  'update_module',
  'add_dependency',
  'remove_dependency'
]

export function isStructural(op: { type: GraphOperationType }): boolean {
  return STRUCTURAL_OPERATIONS.includes(op.type)
}

/** Operations that cannot be carried out without an AI model. */
export const AI_REQUIRED_OPERATIONS: readonly GraphOperationType[] = [
  'move_responsibility',
  'scaffold_module'
]

export function requiresAi(op: { type: GraphOperationType }): boolean {
  return AI_REQUIRED_OPERATIONS.includes(op.type)
}

export function describeOperation(op: GraphOperationBody): string {
  switch (op.type) {
    case 'add_module':
      return `Add module "${op.module.name}"`
    case 'rename_module':
      return `Rename module to "${op.name}"`
    case 'update_module':
      return `Update module properties`
    case 'delete_module':
      return `Delete module (${op.fileDisposition} files)`
    case 'move_file':
      return `Move ${op.file}`
    case 'move_symbol':
      return `Move symbol ${op.symbol}`
    case 'move_responsibility':
      return `Move responsibility "${op.responsibility}"`
    case 'add_dependency':
      return `Add ${op.kind} dependency`
    case 'remove_dependency':
      return `Remove dependency`
    case 'scaffold_module':
      return `Generate implementation for module`
    default: {
      const exhaustive: never = op
      return JSON.stringify(exhaustive)
    }
  }
}

/** Human-readable label for each operation type, used throughout the UI. */
export const OPERATION_LABELS: Record<GraphOperationType, string> = {
  add_module: 'Create module',
  rename_module: 'Rename module',
  update_module: 'Update module properties',
  delete_module: 'Delete module',
  move_file: 'Move file',
  move_symbol: 'Move symbol',
  move_responsibility: 'Move responsibility',
  add_dependency: 'Add dependency',
  remove_dependency: 'Remove dependency',
  scaffold_module: 'Generate module implementation'
}
