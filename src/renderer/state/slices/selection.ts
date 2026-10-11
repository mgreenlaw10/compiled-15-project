/**
 * What is selected on the canvas and in the explorer.
 */

import type { SelectionSlice, Slice } from '../types'

export const createSelectionSlice: Slice<SelectionSlice> = (set, get) => ({
  selectedModuleId: null,
  selectedFile: null,
  selectedOperationId: null,

  select(id) {
    set({ selectedModuleId: id, selectedFile: null, ...(id ? { bottomTab: 'module' as const } : {}) })
  },

  selectFile(path) {
    set({ selectedFile: path, bottomTab: 'module' })
  },

  selectOperation(id) {
    const op = get().operations.find((candidate) => candidate.id === id)
    if (!op) return
    const moduleId = op.type === 'add_module' ? op.module.id
      : 'toModuleId' in op ? op.toModuleId
        : 'moduleId' in op ? op.moduleId : op.to
    set({ selectedOperationId: id, selectedModuleId: moduleId, selectedFile: null,
      bottomTab: 'preview', deskMode: 'review' })
  }
})
