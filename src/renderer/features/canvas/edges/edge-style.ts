/**
 * Dependency arrow appearance and its legend live here.
 *
 * Color identifies the source module, matching its node marker and minimap.
 * Line patterns identify verification: verified dependencies are solid;
 * declared dependencies are dashed. Kind and weight remain available in
 * edge labels. Extend EDGE_STYLES when adding a dependency kind.
 */

import { MarkerType, type Edge } from '@xyflow/react'

import type {
  DependencyEdge,
  DependencyKind
} from '../../../../shared/types/architecture'

export interface EdgeStyle {
  color: string
  /** Shown in the legend. Keep it short enough to read at a glance. */
  label: string
  /** SVG dash pattern, or `undefined` for a solid line. */
  dash?: string
}

/** Legend and line style per dependency kind, for verified edges. */
export const EDGE_STYLES: Record<DependencyKind, EdgeStyle> = {
  imports: { color: 'var(--text-dim)', label: 'verified dependency' },
  calls: { color: 'var(--text-dim)', label: 'verified dependency' },
  depends_on: { color: 'var(--text-dim)', label: 'verified dependency' }
}

/** How an edge the analyzer could not verify in the source is drawn. */
export const UNVERIFIED_STYLE: EdgeStyle = {
  color: 'var(--text-dim)',
  label: 'declared, no import yet',
  dash: '5 4'
}

const FALLBACK_STYLE: EdgeStyle = {
  color: 'var(--text-dim)',
  label: 'dependency'
}

/** The resolved appearance of one edge. */
export function edgeAppearance(edge: DependencyEdge): EdgeStyle {
  const style = edge.verified ? EDGE_STYLES[edge.kind] ?? FALLBACK_STYLE : UNVERIFIED_STYLE
  return { ...style, color: moduleColor(edge.from) }
}

/** Stable source-module color shared by arrows, node markers and the minimap. */
export function moduleColor(id: string): string {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619)
  }
  return `hsl(${(hash >>> 0) % 360}, 54%, 43%)`
}

export function edgeColor(edge: DependencyEdge): string {
  return edgeAppearance(edge).color
}

/**
 * The label drawn on the edge itself, or `undefined` for none.
 *
 * Kept sparse on purpose: a label on every arrow turns a readable graph into a
 * wall of text, so only the things a user cannot infer from the line get one.
 */
export function edgeLabel(edge: DependencyEdge): string | undefined {
  if (!edge.verified) return `${edge.kind} (declared)`
  if (edge.kind !== 'imports') return edge.kind
  return edge.weight > 1 ? `×${edge.weight}` : undefined
}

/** Line thickness: heavier where more imports cross the boundary. */
export function edgeWidth(edge: DependencyEdge): number {
  return edge.verified ? Math.min(1 + edge.weight * 0.35, 3.2) : 1.2
}

/** One architecture edge as React Flow wants it. */
export function toFlowEdge(edge: DependencyEdge, ariaLabel?: string): Edge {
  const style = edgeAppearance(edge)
  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    label: edgeLabel(edge),
    ariaLabel: ariaLabel ?? `${edge.from} to ${edge.to}: ${edge.kind}, ${edge.verified ? 'verified' : 'declared'}`,
    animated: false,
    style: {
      stroke: style.color,
      strokeWidth: edgeWidth(edge),
      strokeDasharray: style.dash
    },
    markerEnd: { type: MarkerType.ArrowClosed, color: style.color },
    labelStyle: { fill: style.color },
    interactionWidth: 24,
    data: { verified: edge.verified, kind: edge.kind }
  }
}

export interface LegendEntry {
  label: string
  color: string
  dash?: string
}

/**
 * Neutral swatches describe line styles; source-module color is explained
 * separately in EdgeLegend. Kinds sharing a line style get one entry.
 */
export const EDGE_LEGEND: readonly LegendEntry[] = (() => {
  const entries: LegendEntry[] = []
  const seen = new Set<string>()

  for (const style of Object.values(EDGE_STYLES)) {
    const key = `${style.color}|${style.dash ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ label: style.label, color: style.color, dash: style.dash })
  }
  entries.push({
    label: UNVERIFIED_STYLE.label,
    color: UNVERIFIED_STYLE.color,
    dash: UNVERIFIED_STYLE.dash
  })
  return entries
})()
