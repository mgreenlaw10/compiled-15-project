import { MarkerType, type Edge } from '@xyflow/react'
import type { DependencyEdge } from '../../../../shared/types/architecture'
import { toFlowEdge } from './edge-style'

export const OVERVIEW_EDGE_COLOR = '#64748b'
const OVERVIEW_PREFIX = 'module-pair:'

function flowPairId(edge: Pick<Edge, 'source' | 'target'>, prefix: string): string {
  return prefix + [edge.source, edge.target].sort().map(encodeURIComponent).join(':')
}
function pairId(edge: DependencyEdge): string {
  return flowPairId({ source: edge.from, target: edge.to }, OVERVIEW_PREFIX)
}

export function isOverviewEdge(id: string): boolean {
  return id.startsWith(OVERVIEW_PREFIX)
}

/** Resolve a displayed arrow without storing synthetic edges in the architecture. */
export function underlyingDependencies(edges: DependencyEdge[], id: string): DependencyEdge[] {
  const exact = edges.find((edge) => edge.id === id)
  return exact ? [exact] : edges.filter((edge) => pairId(edge) === id)
}

/** Collapse each module pair, revealing only the selected module's dependency kinds. */
export function toModuleFlowEdges(edges: DependencyEdge[], selectedModuleId: string | null): Edge[] {
  return collapseFlowEdges(edges.filter((edge) => edge.from !== edge.to).map(toFlowEdge), selectedModuleId, OVERVIEW_PREFIX, 'module')
}

/** The same selection-driven display projection at every level of the graph. */
export function collapseFlowEdges(edges: Edge[], selectedNodeId: string | null, prefix = 'node-pair:', noun = 'node'): Edge[] {
  const groups = new Map<string, Edge[]>()
  for (const edge of edges) {
    const id = flowPairId(edge, prefix)
    groups.set(id, [...(groups.get(id) ?? []), edge])
  }
  return [...groups].flatMap<Edge>(([id, group]) => {
    if (selectedNodeId && group.some((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)) {
      return [...group].sort((a, b) => a.id.localeCompare(b.id)).map((edge, index) => {
        return { ...edge, type: 'dependencyDetail', label: edge.label ?? String(edge.data?.kind ?? 'dependency'),
          data: { ...edge.data, offset: edge.source === edge.target ? 180 + index * 32 : (index - (group.length - 1) / 2) * 32 } }
      })
    }
    const first = group[0]
    const bidirectional = first.source !== first.target && group.some((edge) => edge.source === first.target && edge.target === first.source)
    const verified = group.every((edge) => edge.data?.verified !== false && !edge.style?.strokeDasharray)
    const marker = { type: MarkerType.ArrowClosed, color: OVERVIEW_EDGE_COLOR }
    return [{ id, source: first.source, target: first.target,
      type: first.source === first.target ? 'dependencyDetail' : undefined,
      markerEnd: marker, markerStart: bidirectional ? marker : undefined,
      style: { stroke: OVERVIEW_EDGE_COLOR, strokeWidth: 1.4, strokeDasharray: verified ? undefined : '5 4', opacity: selectedNodeId ? 0.3 : 0.75 },
      deletable: false,
      ariaLabel: `Dependencies ${bidirectional ? 'between' : 'from'} ${first.source} ${bidirectional ? 'and' : 'to'} ${first.target}. Select a ${noun} to inspect details.`,
      data: { overview: true, verified, dependencyIds: group.map((edge) => edge.id), offset: 180 } }]
  })
}

export function underlyingFlowEdges(edges: Edge[], displayed: Edge): Edge[] {
  const ids = displayed.data?.dependencyIds
  return Array.isArray(ids) ? edges.filter((edge) => ids.includes(edge.id)) : edges.filter((edge) => edge.id === displayed.id)
}
