/**
 * Deterministic layered auto-layout.
 *
 * Hand-written rather than pulled from a layout library for two reasons: the
 * result has to be byte-for-byte reproducible (it gets saved into the project
 * document and asserted in tests), and the layout has to run in a plain Node
 * test with no DOM.
 *
 * Dependencies read left to right: a module sits to the left of everything it
 * depends on, so entry points land on the left edge and leaf modules such as
 * database access or utilities land on the right.
 */

import type { ArchitectureGraph, ModuleId, NodePosition } from '../types/architecture'

export const NODE_WIDTH = 240
export const NODE_HEIGHT = 112
export const LAYER_GAP = 120
export const ROW_GAP = 48

export interface LayoutOptions {
  nodeWidth?: number
  nodeHeight?: number
  layerGap?: number
  rowGap?: number
}

/**
 * Assigns each module to a layer. Uses Kahn's algorithm on the dependency DAG;
 * modules left over because they sit in a cycle are placed one layer past
 * their already-resolved predecessors, so a cyclic graph still lays out.
 */
export function assignLayers(graph: ArchitectureGraph): Map<ModuleId, number> {
  const ids = graph.modules.map((m) => m.id)
  const idSet = new Set(ids)
  const edges = graph.edges.filter(
    (e) => e.from !== e.to && idSet.has(e.from) && idSet.has(e.to)
  )

  const incoming = new Map<ModuleId, Set<ModuleId>>()
  const outgoing = new Map<ModuleId, Set<ModuleId>>()
  for (const id of ids) {
    incoming.set(id, new Set())
    outgoing.set(id, new Set())
  }
  for (const e of edges) {
    outgoing.get(e.from)!.add(e.to)
    incoming.get(e.to)!.add(e.from)
  }

  const layer = new Map<ModuleId, number>()
  const remainingIn = new Map<ModuleId, number>(
    ids.map((id) => [id, incoming.get(id)!.size])
  )

  // Sorted queue keeps the result independent of module ordering in the array.
  let frontier = ids.filter((id) => remainingIn.get(id) === 0).sort()
  for (const id of frontier) layer.set(id, 0)

  while (frontier.length > 0) {
    const next: ModuleId[] = []
    for (const id of frontier) {
      for (const dep of [...outgoing.get(id)!].sort()) {
        const candidate = layer.get(id)! + 1
        layer.set(dep, Math.max(layer.get(dep) ?? 0, candidate))
        remainingIn.set(dep, remainingIn.get(dep)! - 1)
        if (remainingIn.get(dep) === 0) next.push(dep)
      }
    }
    frontier = next.sort()
  }

  // Anything still unassigned is inside a cycle.
  for (const id of ids.sort()) {
    if (layer.has(id)) continue
    const resolvedPreds = [...incoming.get(id)!]
      .map((p) => layer.get(p))
      .filter((v): v is number => v !== undefined)
    layer.set(id, resolvedPreds.length ? Math.max(...resolvedPreds) + 1 : 0)
  }

  return layer
}

/**
 * Orders nodes within each layer by the average position of their predecessors
 * (a single barycenter pass). Cheap, deterministic, and good enough to keep
 * most edges from crossing.
 */
function orderWithinLayers(
  graph: ArchitectureGraph,
  layers: Map<ModuleId, number>
): ModuleId[][] {
  const maxLayer = Math.max(0, ...[...layers.values()])
  const rows: ModuleId[][] = Array.from({ length: maxLayer + 1 }, () => [])
  const byId = new Map(graph.modules.map((m) => [m.id, m]))

  for (const [id, l] of [...layers.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  )) {
    rows[l].push(id)
  }

  // Layer 0 ordered by name for a stable, readable starting point.
  rows[0].sort((a, b) => {
    const na = byId.get(a)?.name ?? a
    const nb = byId.get(b)?.name ?? b
    return na.localeCompare(nb) || a.localeCompare(b)
  })

  const indexIn = (row: ModuleId[], id: ModuleId): number => row.indexOf(id)

  for (let l = 1; l < rows.length; l += 1) {
    const prev = rows[l - 1]
    const barycenter = new Map<ModuleId, number>()
    for (const id of rows[l]) {
      const preds = graph.edges
        .filter((e) => e.to === id && layers.get(e.from) === l - 1)
        .map((e) => indexIn(prev, e.from))
        .filter((i) => i >= 0)
      barycenter.set(
        id,
        preds.length
          ? preds.reduce((a, b) => a + b, 0) / preds.length
          : Number.POSITIVE_INFINITY
      )
    }
    rows[l].sort((a, b) => {
      const d = barycenter.get(a)! - barycenter.get(b)!
      if (Number.isFinite(d) && d !== 0) return d
      const na = byId.get(a)?.name ?? a
      const nb = byId.get(b)?.name ?? b
      return na.localeCompare(nb) || a.localeCompare(b)
    })
  }

  return rows
}

/** Computes positions for every module in the graph. */
export function layoutGraph(
  graph: ArchitectureGraph,
  options: LayoutOptions = {}
): Record<ModuleId, NodePosition> {
  const nodeWidth = options.nodeWidth ?? NODE_WIDTH
  const nodeHeight = options.nodeHeight ?? NODE_HEIGHT
  const layerGap = options.layerGap ?? LAYER_GAP
  const rowGap = options.rowGap ?? ROW_GAP

  const layers = assignLayers(graph)
  const rows = orderWithinLayers(graph, layers)
  const tallest = Math.max(1, ...rows.map((r) => r.length))
  const canvasHeight = tallest * nodeHeight + (tallest - 1) * rowGap

  const positions: Record<ModuleId, NodePosition> = {}
  rows.forEach((row, layerIndex) => {
    const columnHeight = row.length * nodeHeight + (row.length - 1) * rowGap
    const top = (canvasHeight - columnHeight) / 2
    row.forEach((id, rowIndex) => {
      positions[id] = {
        x: layerIndex * (nodeWidth + layerGap),
        y: Math.round(top + rowIndex * (nodeHeight + rowGap))
      }
    })
  })

  return positions
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
