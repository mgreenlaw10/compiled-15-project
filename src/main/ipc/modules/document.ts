/**
 * The saved architecture document, and reading project files for the inspector.
 */

import { promises as fs } from 'node:fs'

import type { ReadFileResult, SaveDocumentRequest } from '../../../shared/ipc'
import { DOCUMENT_CHANNELS } from '../../../shared/ipc'
import { loadDocument, saveDocument } from '../../services/document-store'
import { asString, resolveInsideProject, type HandlerModule } from '../context'

const MAX_READ_CHARS = 400_000

export const documentHandlers: HandlerModule = (ctx) => ({
  [DOCUMENT_CHANNELS.loadDocument]: async (_e: unknown, root: unknown) =>
    loadDocument(asString(root, 'root')),

  [DOCUMENT_CHANNELS.saveDocument]: async (_e: unknown, req: unknown) => {
    const request = req as SaveDocumentRequest
    if (!request?.document?.projectRoot) {
      throw new Error('The document has no project root')
    }
    const saved = await saveDocument(request.document)
    ctx.log.success(`Saved the architecture to ${saved.path}`)
    return saved
  },

  [DOCUMENT_CHANNELS.readProjectFile]: async (
    _e: unknown,
    root: unknown,
    relPath: unknown
  ): Promise<ReadFileResult> => {
    const projectRoot = asString(root, 'root')
    const rel = asString(relPath, 'path')
    const target = resolveInsideProject(projectRoot, rel)
    const content = await fs.readFile(target, 'utf8')
    return {
      path: rel,
      content:
        content.length > MAX_READ_CHARS
          ? content.slice(0, MAX_READ_CHARS)
          : content,
      truncated: content.length > MAX_READ_CHARS
    }
  }
})
