/**
 * The persisted project document and the smaller DTOs the GUI needs.
 */

import type { ArchitectureGraph, GraphLayout } from './architecture'
import type { GraphOperation } from './operations'

export const DOCUMENT_SCHEMA_VERSION = 1

/** File name written inside the analyzed project. */
export const DOCUMENT_FILENAME = 'architecture.cartograph.json'
/** Directory inside the analyzed project used for the document and backups. */
export const CARTOGRAPH_DIR = '.cartograph'

/**
 * Everything Cartograph persists for a project.
 *
 * `original` is the architecture as extracted from the codebase; `desired` is
 * the architecture after the user's edits. Keeping both lets the engine diff
 * them and lets the GUI mark which modules have pending, unapplied changes.
 */
export interface ArchitectureDocument {
  schemaVersion: number
  projectRoot: string
  original: ArchitectureGraph
  desired: ArchitectureGraph
  layout: GraphLayout
  /** Ordered log of structural + metadata edits taking `original` to `desired`. */
  operations: GraphOperation[]
  /** Subset of `operations` whose code changes have been written to disk. */
  appliedOperationIds: string[]
  savedAt: string
}

export interface ProjectInfo {
  root: string
  name: string
  /** Contents of the project's `package.json` `name` field, when present. */
  packageName: string | null
  hasPackageJson: boolean
  hasTsConfig: boolean
  isGitRepo: boolean
  /** `npm test`-able: a `test` script exists. */
  hasTestScript: boolean
  /** Scripts found in package.json, for display. */
  scripts: Record<string, string>
}

export interface FileTreeNode {
  name: string
  /** Project-relative POSIX path. */
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
  /** Module the file currently belongs to, if any. */
  moduleId?: string
}
