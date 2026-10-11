/**
 * Saving and restoring the architecture document.
 *
 * `restoreDocument` is worth reading before building anything multi-writer: it
 * is already a merge. The saved document's `original` is a snapshot of how the
 * code looked when it was saved, and the code may have moved on since, so the
 * freshly analyzed graph stays authoritative and the saved *operation log* is
 * replayed onto it — the same mechanism a shared backend would use to catch a
 * client up on someone else's edits.
 */

import { DOCUMENT_SCHEMA_VERSION } from '../../../shared/types/project'
import { applyOperations } from '../../../shared/graph/apply-operation'
import { fillMissingPositions } from '../../../shared/graph/layout'
import type { ArchitectureDocument } from '../../../shared/types/project'
import type { LogEvent } from '../../../shared/ipc'
import type { DocumentSlice, Slice } from '../types'
import { MAX_LOGS, uiLog } from './logs'

export const createDocumentSlice: Slice<DocumentSlice> = (set, get) => ({
  dirty: false,

  async saveDocument() {
    const { project, original, desired, layout, operations, appliedOperationIds } =
      get()
    if (!project || !original || !desired) return
    set({ busy: 'saving', error: null })
    try {
      const document: ArchitectureDocument = {
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        projectRoot: project.root,
        original,
        desired,
        layout,
        operations,
        appliedOperationIds,
        savedAt: new Date().toISOString()
      }
      const saved = await window.cartograph.saveDocument({ document })
      set({
        busy: 'idle',
        dirty: false,
        notice: `Saved the architecture to ${saved.path}`
      })
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  restoreDocument(document) {
    const fresh = get().original
    if (!fresh) {
      set({
        original: document.original,
        desired: document.desired,
        layout: document.layout,
        operations: document.operations,
        appliedOperationIds: document.appliedOperationIds
      })
      return
    }

    // Operations that no longer apply are reported rather than dropped in
    // silence: a user who edited the source under us needs to know which of
    // their recorded edits did not survive.
    const replay = applyOperations(fresh, document.operations)
    const stale = new Set(replay.failures.map((f) => f.operationId))
    const kept = document.operations.filter((op) => !stale.has(op.id))

    const logs: LogEvent[] = [
      uiLog(
        'info',
        'app',
        `Restored the saved architecture: replayed ${kept.length} of ${document.operations.length} recorded edit(s) onto the current source (saved ${new Date(
          document.savedAt
        ).toLocaleString()})`
      ),
      ...replay.warnings.map((w) => uiLog('warn', 'app', w)),
      ...replay.failures.map((f) =>
        uiLog(
          'warn',
          'app',
          `A saved edit no longer applies and was dropped: ${f.error}`,
          f.operationId
        )
      )
    ]

    set((state) => ({
      desired: replay.graph,
      layout: {
        ...document.layout,
        positions: fillMissingPositions(replay.graph, document.layout.positions)
      },
      operations: kept,
      appliedOperationIds: document.appliedOperationIds,
      selectedModuleId: replay.graph.modules[0]?.id ?? null,
      dirty: replay.failures.length > 0,
      logs: [...state.logs, ...logs].slice(-MAX_LOGS)
    }))
  }
})
