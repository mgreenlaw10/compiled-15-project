/**
 * What is selected on the canvas and in the explorer.
 */

import type { SelectionSlice, Slice } from '../types'

export const createSelectionSlice: Slice<SelectionSlice> = (set) => ({
  selectedModuleId: null,
  selectedFile: null,

  select(id) {
    set({ selectedModuleId: id, selectedFile: null })
  },

  selectFile(path) {
    set({ selectedFile: path })
  }
})
