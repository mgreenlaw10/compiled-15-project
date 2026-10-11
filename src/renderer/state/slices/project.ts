/**
 * Opening a project and analyzing it.
 */

import { pendingOperations } from '../selectors'
import type { ProjectSlice, Slice } from '../types'

export const createProjectSlice: Slice<ProjectSlice> = (set, get) => ({
  project: null,
  fileTree: null,

  async openProject() {
    set({ busy: 'opening', error: null })
    try {
      const result = await window.cartograph.openProject()
      if (result.canceled || !result.project) {
        set({ busy: 'idle' })
        return
      }
      set({ project: result.project, busy: 'idle' })
      await get().analyze({ restoreSaved: true })
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async openProjectAt(root: string) {
    set({ busy: 'opening', error: null })
    try {
      const result = await window.cartograph.openProjectAt(root)
      if (!result.project) {
        set({ busy: 'idle' })
        return
      }
      set({ project: result.project, busy: 'idle' })
      await get().analyze({ restoreSaved: true })
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async analyze(options = {}) {
    const project = get().project
    if (!project) return

    // Re-analyzing rebuilds the graph from source, which drops any edit that
    // has not been written yet. Losing that silently would be the worst kind
    // of bug, so it is confirmed first.
    const unapplied = pendingOperations(get()).length
    if (unapplied > 0 && options.force !== true) {
      const proceed =
        typeof globalThis.confirm === 'function'
          ? globalThis.confirm(
              `Re-analyzing reads the architecture back from the source code, which discards ${unapplied} edit(s) you have not generated yet.

Continue?`
            )
          : false
      if (!proceed) return
    }

    const settings = get().settings
    const useAi =
      options.useAi ??
      (settings?.aiAssistAnalysis === true && settings?.hasApiKey === true)

    set({
      busy: 'analyzing',
      error: null,
      changeSet: null,
      diffs: null,
      applyResult: null,
      validation: null,
      bottomTab: 'activity'
    })

    try {
      const result = await window.cartograph.analyze(project.root, { useAi })
      set({
        project: result.project,
        fileTree: result.fileTree,
        original: result.graph,
        desired: result.graph,
        layout: result.layout,
        operations: [],
        appliedOperationIds: [],
        selectedModuleId: result.graph.modules[0]?.id ?? null,
        selectedFile: null,
        viewScope: null,
        selectedSymbolId: null,
        selectedRelationshipId: null,
        dirty: false,
        busy: 'idle'
      })

      if (options.restoreSaved && result.savedDocument) {
        get().restoreDocument(result.savedDocument)
      }
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async cancel() {
    await window.cartograph.cancelWork()
    set({ busy: 'idle' })
  }
})
