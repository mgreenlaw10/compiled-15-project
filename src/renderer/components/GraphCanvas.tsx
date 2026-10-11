/**
 * The architecture canvas.
 *
 * Pan, zoom, drag, select, connect and disconnect. The important distinction
 * this component enforces is the one the brief calls for: dragging a node
 * writes to `layout` only, while drawing or deleting an edge records a
 * *structural* operation. Position changes can never trigger a code change.
 */

import { useCallback, useEffect, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type OnNodeDrag
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { DependencyEdge } from '../../shared/types/architecture'
import { useModulesWithPendingChanges, useStore } from '../state/store'
import {
  ModuleNodeView,
  type FileDragPayload,
  type ModuleNodeData
} from './ModuleNodeView'

const nodeTypes = { module: ModuleNodeView }

function edgeColor(edge: DependencyEdge): string {
  if (!edge.verified) return '#8b93a3'
  if (edge.kind === 'calls') return '#c08cf5'
  return '#4d6a94'
}

function edgeLabel(edge: DependencyEdge): string | undefined {
  if (!edge.verified) return `${edge.kind} (declared)`
  if (edge.kind !== 'imports') return edge.kind
  return edge.weight > 1 ? `×${edge.weight}` : undefined
}

export function GraphCanvas(): JSX.Element {
  const graph = useStore((s) => s.desired)
  const layout = useStore((s) => s.layout)
  const selectedModuleId = useStore((s) => s.selectedModuleId)
  const pending = useModulesWithPendingChanges()

  const select = useStore((s) => s.select)
  const setPosition = useStore((s) => s.setPosition)
  const setExpanded = useStore((s) => s.setExpanded)
  const dispatchOperation = useStore((s) => s.dispatchOperation)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ModuleNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const onToggleExpand = useCallback(
    (id: string) => setExpanded(id, !layout.expanded[id]),
    [layout.expanded, setExpanded]
  )

  const onDropFile = useCallback(
    (payload: FileDragPayload, targetModuleId: string) => {
      if (payload.fromModuleId === targetModuleId) return
      dispatchOperation({
        type: 'move_file',
        file: payload.file,
        fromModuleId: payload.fromModuleId,
        toModuleId: targetModuleId
      })
    },
    [dispatchOperation]
  )

  const computed = useMemo(() => {
    if (!graph) return { nodes: [] as Node<ModuleNodeData>[], edges: [] as Edge[] }

    const nextNodes: Node<ModuleNodeData>[] = graph.modules.map((module) => ({
      id: module.id,
      type: 'module',
      position: layout.positions[module.id] ?? { x: 0, y: 0 },
      // The custom node draws its own frame, so React Flow's default
      // chrome is turned off.
      style: { width: 240 },
      selected: module.id === selectedModuleId,
      deletable: false,
      data: {
        module,
        isSelected: module.id === selectedModuleId,
        isPending: pending.has(module.id),
        expanded: layout.expanded[module.id] === true,
        onToggleExpand,
        onDropFile
      }
    }))

    const nextEdges: Edge[] = graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edgeLabel(edge),
      animated: false,
      style: {
        stroke: edgeColor(edge),
        strokeWidth: edge.verified ? Math.min(1 + edge.weight * 0.35, 3.2) : 1.2,
        strokeDasharray: edge.verified ? undefined : '5 4'
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor(edge) },
      data: { verified: edge.verified }
    }))

    return { nodes: nextNodes, edges: nextEdges }
  }, [graph, layout, selectedModuleId, pending, onToggleExpand, onDropFile])

  // React Flow owns node positions while a drag is in flight, so the canvas is
  // re-seeded from the store whenever the architecture or the layout changes
  // rather than being rendered straight from it.
  useEffect(() => {
    setNodes(computed.nodes)
    setEdges(computed.edges)
  }, [computed, setNodes, setEdges])

  const onNodeDragStop = useCallback<OnNodeDrag<Node<ModuleNodeData>>>(
    (_event, node) => {
      setPosition(node.id, {
        x: Math.round(node.position.x),
        y: Math.round(node.position.y)
      })
    },
    [setPosition]
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      dispatchOperation({
        type: 'add_dependency',
        from: connection.source,
        to: connection.target,
        kind: 'depends_on'
      })
    },
    [dispatchOperation]
  )

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const edge of deleted) {
        dispatchOperation({
          type: 'remove_dependency',
          from: edge.source,
          to: edge.target
        })
      }
    },
    [dispatchOperation]
  )

  if (!graph) {
    return (
      <div className="canvas-wrap">
        <div className="canvas-hint">
          <p style={{ fontSize: 15, color: 'var(--text-dim)' }}>
            No project open.
          </p>
          <p>
            Choose <strong>Open Project</strong> to pick a TypeScript or
            JavaScript codebase. Cartograph will read it, work out its modules,
            and draw the architecture here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_event, node) => select(node.id)}
        onPaneClick={() => select(null)}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        deleteKeyCode="Delete"
        minZoom={0.15}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2a2f38" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) =>
            pending.has(node.id) ? '#f2c14e' : '#4d6a94'
          }
          maskColor="rgba(20, 22, 26, 0.72)"
        />
      </ReactFlow>

      {graph.modules.length === 0 ? (
        <div className="canvas-hint">
          <p>
            No modules were found. Cartograph currently reads TypeScript and
            JavaScript — check that the project has source files outside
            <code> node_modules</code>, or add a module by hand.
          </p>
        </div>
      ) : null}

      <div className="canvas-legend">
        <div>
          <span className="swatch" style={{ borderTopColor: '#4d6a94' }} />
          verified import
        </div>
        <div>
          <span className="swatch dashed" />
          declared, no import yet
        </div>
        <div>
          <span
            className="swatch"
            style={{ borderTop: '2px dashed var(--warn)' }}
          />
          module with pending change
        </div>
      </div>
    </div>
  )
}
