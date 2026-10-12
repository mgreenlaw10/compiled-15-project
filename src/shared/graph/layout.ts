/**
 * Graph layout: which algorithm positions modules, plus filling in positions
 * for modules added after a layout was computed.
 *
 * Two algorithms, both deterministic and DOM-free:
 *
 *   - `force` (the default auto-layout) — `./force-layout.ts`. Spaces modules
 *     by how they relate: coupled modules cluster, unrelated ones keep apart,
 *     and dependencies still read left to right.
 *   - `layered` — `./layered-layout.ts`. Strict columns by dependency depth.
 *     Also the force layout's starting point.
 */

import type { ArchitectureGraph, ModuleId, NodePosition } from '../types/architecture'
import { forceDirectedLayout, type ForceLayoutOptions } from './force-layout'
import {
  LAYER_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  ROW_GAP,
  layeredLayout,
  type LayoutOptions
} from './layered-layout'

export {
  assignLayers,
  LAYER_GAP,
  layeredLayout,
  NODE_HEIGHT,
  NODE_WIDTH,
  ROW_GAP,
  type LayoutOptions
} from './layered-layout'
export { forceDirectedLayout, type ForceLayoutOptions } from './force-layout'

export type LayoutAlgorithm = 'force' | 'layered'

/** The auto-layout. Force-directed unless asked otherwise. */
export function layoutGraph(
  graph: ArchitectureGraph,
  options: ForceLayoutOptions & { algorithm?: LayoutAlgorithm } = {}
): Record<ModuleId, NodePosition> {
  if (options.algorithm === 'layered') return layeredLayout(graph, options)
  return forceDirectedLayout(graph, options)
}

/** Positions for modules that do not have one yet, leaving existing ones alone. */
export function fillMissingPositions(
  graph: ArchitectureGraph,
  existing: Record<ModuleId, NodePosition>,
  options: LayoutOptions = {}
): Record<ModuleId, NodePosition> {
  const missing = graph.modules.filter((m) => !existing[m.id])
  if (missing.length === 0) return existing

  const nodeHeight = options.nodeHeight ?? NODE_HEIGHT
  const rowGap = options.rowGap ?? ROW_GAP
  const taken = Object.values(existing)
  const maxX = taken.length ? Math.max(...taken.map((p) => p.x)) : 0
  const minY = taken.length ? Math.min(...taken.map((p) => p.y)) : 0

  const next = { ...existing }
  missing.forEach((m, i) => {
    next[m.id] = {
      x: maxX + (options.nodeWidth ?? NODE_WIDTH) + (options.layerGap ?? LAYER_GAP),
      y: minY + i * (nodeHeight + rowGap)
    }
  })
  return next
}
