/**
 * Opening and analyzing a project.
 *
 * Served by `src/main/ipc/modules/project.ts`.
 */

import type { ArchitectureGraph, GraphLayout } from '../types/architecture'
import type {
  ArchitectureDocument,
  FileTreeNode,
  ProjectInfo
} from '../types/project'

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

export interface ProjectApi {
  /** Native folder picker. Returns `canceled: true` if dismissed. */
  openProject(): Promise<OpenProjectResult>
  /** Open a specific directory without a dialog (used by tests and recents). */
  openProjectAt(root: string): Promise<OpenProjectResult>
  analyze(root: string, options: AnalyzeOptions): Promise<AnalyzeResult>
}
