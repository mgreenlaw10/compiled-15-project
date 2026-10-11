/**
 * What is selected on the canvas and in the explorer.
 */

import type { SelectionSlice, Slice } from '../types'

export const createSelectionSlice: Slice<SelectionSlice> = (set, get) => ({
  viewScope: null,
  selectedSymbolId: null,
  selectedRelationshipId: null,
  openModule(id) { set({ viewScope: { moduleId: id }, selectedModuleId: id, selectedFile: null, selectedSymbolId: null, selectedRelationshipId: null }) },
  openFile(moduleId, file) { set({ viewScope: { moduleId, file }, selectedModuleId: moduleId, selectedFile: file, selectedSymbolId: null, selectedRelationshipId: null }) },
  backToProject() { set({ viewScope: null, selectedFile: null, selectedSymbolId: null, selectedRelationshipId: null }) },
  selectSymbol(id) {
    const graph = get().desired
    const symbol = graph?.program.symbols.find((s) => s.id === id || s.fields.some((f) => f.id === id))
    const contract = id?.startsWith('contract:') ? graph?.program.contracts.find((c) => c.id === id.slice(9)) : undefined
    const owner = graph?.modules.find((m) => symbol ? m.files.includes(symbol.source.file) : contract?.moduleId === m.id)
    set({ selectedSymbolId: id, selectedRelationshipId: null, selectedFile: null, ...(owner ? { selectedModuleId: owner.id } : {}) })
  },
  selectRelationship(id) { set({ selectedRelationshipId: id }) },
  selectedModuleId: null,
  selectedFile: null,

  select(id) {
    set({ selectedModuleId: id, selectedFile: null, selectedSymbolId: null, selectedRelationshipId: null })
  },

  selectFile(path) {
    const owner = get().desired?.modules.find((m) => path && m.files.includes(path))
    set({ selectedFile: path, selectedSymbolId: null, selectedRelationshipId: null, ...(owner ? { selectedModuleId: owner.id } : {}) })
  }
})
