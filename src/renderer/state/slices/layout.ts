/**
 * Node positions and expansion state.
 *
 * Entirely visual. Nothing in this slice records an operation, which is what
 * lets the status bar say truthfully whether there is a pending change that
 * would alter code.
 */

import { layoutGraph } from '../../../shared/graph/layout'
import { createLayout } from '../../../shared/graph/model'
import type { LayoutSlice, Slice } from '../types'

export const createLayoutSlice: Slice<LayoutSlice> = (set, get) => ({
  layout: createLayout(),

  setPosition(id, position) {
    set((state) => ({
      layout: {
        ...state.layout,
        algorithm: 'manual',
        positions: { ...state.layout.positions, [id]: position },
        version: state.layout.version + 1
      },
      dirty: true
    }))
  },

  setExpanded(id, expanded) {
    set((state) => ({
      layout: {
        ...state.layout,
        expanded: { ...state.layout.expanded, [id]: expanded },
        version: state.layout.version + 1
      }
    }))
  },

  relayout() {
    const graph = get().desired
    if (!graph) return
    set((state) => ({
      layout: {
        ...state.layout,
        algorithm: 'force',
        positions: layoutGraph(graph),
        version: state.layout.version + 1
      },
      dirty: true,
      notice: 'Re-laid out the graph. Layout is visual only — no code changed.'
    }))
  }
})
