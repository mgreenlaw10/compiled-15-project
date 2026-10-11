/**
 * How dependency edges look.
 *
 * Colour on this canvas carries meaning, not decoration: a user should be able
 * to tell a verified import from a declared-but-absent one, and a call
 * dependency from a plain import, without clicking anything. That is why the
 * mapping lives in one place and the legend is generated from the same data —
 * a swatch in the corner that disagrees with the arrows on the canvas is worse
 * than no legend at all.
 *
 * ---------------------------------------------------------------------------
 * Changing how edges are drawn
 * ---------------------------------------------------------------------------
 * Everything visual about an edge is decided here: `EDGE_STYLES` maps each
 * dependency kind to a colour and a dash pattern, `edgeAppearance` resolves one
 * edge against it, and `EDGE_LEGEND` is derived from the result. The canvas
 * calls `toFlowEdge` and renders `EDGE_LEGEND`, so adding a kind or recolouring
 * one does not mean touching `../GraphCanvas.tsx`.
 *
 * Two rules worth keeping:
 *
 *   - An unverified edge must stay visually distinct from a verified one. The
 *     graph presents verified edges as fact; a declared dependency the analyzer
 *     could not find in the source is a different claim and must not look like
 *     one.
 *   - Every colour used on the canvas needs a legend entry. `EDGE_LEGEND`
 *     makes that automatic as long as new kinds go in `EDGE_STYLES`.
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

/** Colour and line style per dependency kind, for verified edges. */
export const EDGE_STYLES: Record<DependencyKind, EdgeStyle> = {
  imports: { color: '#4d6a94', label: 'verified import' },
  calls: { color: '#c08cf5', label: 'call' },
  types: { color: '#5fc6ae', label: 'type dependency' },
  fields: { color: '#e3ac67', label: 'field / shared state' },
  contracts: { color: '#e482a7', label: 'contract reliance' },
  depends_on: { color: '#4d6a94', label: 'verified import' }
}

/** How an edge the analyzer could not verify in the source is drawn. */
export const UNVERIFIED_STYLE: EdgeStyle = {
  color: '#8b93a3',
  label: 'potential / user declared',
  dash: '5 4'
}

const FALLBACK_STYLE: EdgeStyle = {
  color: '#8b93a3',
  label: 'dependency'
}

/** The resolved appearance of one edge. */
export function edgeAppearance(edge: DependencyEdge): EdgeStyle {
  if (!edge.verified) return { ...(EDGE_STYLES[edge.kind] ?? UNVERIFIED_STYLE), dash: UNVERIFIED_STYLE.dash }
  return EDGE_STYLES[edge.kind] ?? FALLBACK_STYLE
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
  if (!edge.verified) return `${edge.kind} (${edge.origin === 'user' ? 'declared' : 'potential'})`
  if (edge.kind !== 'imports') return edge.kind
  return edge.weight > 1 ? `×${edge.weight}` : undefined
}

/** Line thickness: heavier where more imports cross the boundary. */
export function edgeWidth(edge: DependencyEdge): number {
  return edge.verified ? Math.min(1 + edge.weight * 0.35, 3.2) : 1.2
}

/** One architecture edge as React Flow wants it. */
export function toFlowEdge(edge: DependencyEdge): Edge {
  const style = edgeAppearance(edge)
  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    label: edgeLabel(edge),
    animated: false,
    style: {
      stroke: style.color,
      strokeWidth: edgeWidth(edge),
      strokeDasharray: style.dash
    },
    markerEnd: { type: MarkerType.ArrowClosed, color: style.color },
    data: { verified: edge.verified, kind: edge.kind }
  }
}

export interface LegendEntry {
  label: string
  color: string
  dash?: string
}

/**
 * The canvas legend, derived from the styles above so it cannot drift from what
 * is actually drawn. Kinds that share a colour are collapsed into one entry.
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

/** Colour for a module node in the minimap. */
export const NODE_COLOR = '#4d6a94'
export const PENDING_NODE_COLOR = '#f2c14e'
