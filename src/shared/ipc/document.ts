/**
 * Reading and writing the saved architecture document, and reading project
 * files for the inspector.
 *
 * Served by `src/main/ipc/modules/document.ts`.
 */

import type { ArchitectureDocument } from '../types/project'

export interface SaveDocumentRequest {
  document: ArchitectureDocument
}

export interface ReadFileResult {
  path: string
  content: string
  truncated: boolean
}

export interface DocumentApi {
  loadDocument(root: string): Promise<ArchitectureDocument | null>
  saveDocument(req: SaveDocumentRequest): Promise<{ path: string }>
  readProjectFile(root: string, relPath: string): Promise<ReadFileResult>
}
