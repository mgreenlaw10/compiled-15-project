/**
 * The architecture canvas.
 *
 * Pan, zoom, drag, select, connect and disconnect. The important distinction
 * this component enforces is the one the brief calls for: dragging a node
 * writes to `layout` only, while drawing or deleting an edge records a
 * *structural* operation. Position changes can never trigger a code change.
 */

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
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
  type ReactFlowInstance,
  type OnNodeDrag
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { DependencyEdge } from '../../shared/types/architecture'
import { useModulesWithPendingChanges, useStore } from '../state/store'
import { CanvasContextMenu, type CanvasMenuItem } from './CanvasContextMenu'
import { moduleColor } from './graph-colors'
import {
  ModuleNodeView,
  type FileDragPayload,
  type ModuleNodeData
} from './ModuleNodeView'

const nodeTypes = { module: ModuleNodeView }

function edgeLabel(edge: DependencyEdge): string | undefined {
  if (!edge.verified) return `${edge.kind} (declared)`
  if (edge.kind !== 'imports') return edge.kind
  return edge.weight > 1 ? `×${edge.weight}` : undefined
}

export function GraphCanvas(): JSX.Element {
  const graph = useStore((s) => s.desired)
  const layout = useStore((s) => s.layout)
  const selectedModuleId = useStore((s) => s.selectedModuleId)
  const busy = useStore((s) => s.busy)
  const dialog = useStore((s) => s.dialog)
  const openDialog = useStore((s) => s.openDialog)
  const relayout = useStore((s) => s.relayout)
  const pending = useModulesWithPendingChanges()
  const [flow, setFlow] = useState<ReactFlowInstance<Node<ModuleNodeData>, Edge> | null>(null)
  const [focusConnections, setFocusConnections] = useState(false)
  const [menu, setMenu] = useState<{
    x: number; y: number; title: string; items: CanvasMenuItem[]
  } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  useEffect(() => { closeMenu() }, [graph, busy, dialog, closeMenu])

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

    const focused = focusConnections && selectedModuleId !== null
    const connected = new Set([selectedModuleId])
    for (const edge of graph.edges) {
      if (edge.from === selectedModuleId || edge.to === selectedModuleId) {
        connected.add(edge.from)
        connected.add(edge.to)
      }
    }

    const nextNodes: Node<ModuleNodeData>[] = graph.modules.map((module) => ({
      id: module.id,
      type: 'module',
      position: layout.positions[module.id] ?? { x: 0, y: 0 },
      // The custom node draws its own frame, so React Flow's default
      // chrome is turned off.
      style: { width: 240, opacity: focused && !connected.has(module.id) ? 0.3 : 1 },
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
      ariaLabel: `${graph.modules.find((m) => m.id === edge.from)?.name} to ${graph.modules.find((m) => m.id === edge.to)?.name}: ${edge.kind}, ${edge.verified ? 'verified' : 'declared'}`,
      animated: false,
      style: {
        stroke: moduleColor(edge.from),
        opacity: focused && edge.from !== selectedModuleId && edge.to !== selectedModuleId ? 0.12 : 1,
        strokeWidth: edge.verified ? Math.min(1 + edge.weight * 0.35, 3.2) : 1.2,
        strokeDasharray: edge.verified ? undefined : '5 4'
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: moduleColor(edge.from) },
      labelStyle: { fill: moduleColor(edge.from) },
      interactionWidth: 24,
      data: { verified: edge.verified }
    }))

    return { nodes: nextNodes, edges: nextEdges }
  }, [graph, layout, selectedModuleId, pending, focusConnections, onToggleExpand, onDropFile])

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

  const showMenu = (event: MouseEvent | globalThis.MouseEvent, nodeId?: string, edgeId?: string): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!graph || !flow) return
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const module = graph.modules.find((m) => m.id === nodeId)
    const edge = graph.edges.find((e) => e.id === edgeId)
    const idle = busy === 'idle'
    const items: CanvasMenuItem[] = []
    if (module) {
      select(module.id)
      items.push(
        { label: layout.expanded[module.id] ? 'Hide files' : 'Show files',
          action: () => setExpanded(module.id, !layout.expanded[module.id]) },
        { label: 'Focus connections', action: () => setFocusConnections(true) },
        { label: 'Delete module…', danger: true, disabled: !idle,
          action: () => openDialog('delete-module') }
      )
    }
    if (edge) {
      const source = graph.modules.find((m) => m.id === edge.from)!
      const target = graph.modules.find((m) => m.id === edge.to)!
      items.push(
        { label: `Inspect source: ${source.name}`, action: () => select(source.id) },
        { label: `Inspect target: ${target.name}`, action: () => select(target.id) },
        { label: 'Remove dependency', danger: true, disabled: !idle,
          action: () => { dispatchOperation({ type: 'remove_dependency', from: edge.from, to: edge.to }) } }
      )
    }
    items.push(
      { label: 'Add module here…', separator: items.length > 0, disabled: !idle,
        action: () => openDialog('add-module', point) },
      { label: 'Fit graph to view', action: () => { void flow.fitView({ padding: 0.18, maxZoom: 1, duration: 200 }) } },
      { label: 'Auto layout', action: relayout, disabled: !idle }
    )
    setMenu({ x: event.clientX, y: event.clientY,
      title: module?.name ?? (edge ? `${edge.kind} · ${edge.verified ? 'verified' : 'declared'}` : 'Canvas'), items })
  }

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
        onInit={setFlow}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_event, node) => { closeMenu(); select(node.id) }}
        onPaneClick={() => { closeMenu(); select(null) }}
        onPaneContextMenu={(event) => showMenu(event)}
        onNodeContextMenu={(event, node) => showMenu(event, node.id)}
        onEdgeContextMenu={(event, edge) => showMenu(event, undefined, edge.id)}
        onMoveStart={closeMenu}
        onNodeDragStart={closeMenu}
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
        colorMode="light"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#cdd0df" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) =>
            pending.has(node.id) ? '#f2c14e' : moduleColor(node.id)
          }
          maskColor="rgba(241, 242, 248, 0.72)"
        />
      </ReactFlow>

      <div className="canvas-tools">
        <button className="btn btn--sm" aria-pressed={focusConnections}
          disabled={!selectedModuleId}
          title="Dim modules and arrows unrelated to the selected module"
          onClick={() => setFocusConnections((value) => !value)}>
          Focus connections{focusConnections ? ' · on' : ''}
        </button>
        <span>Right-click for actions</span>
        <button className="btn btn--sm" disabled={!selectedModuleId}
          onClick={() => {
            const position = selectedModuleId ? layout.positions[selectedModuleId] : undefined
            if (position) void flow?.setCenter(position.x + 120, position.y + 60, { zoom: 0.9 })
          }} title="Zoom to the selected module">
          Center selected
        </button>
      </div>
      {menu ? <CanvasContextMenu {...menu} onClose={closeMenu} /> : null}

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
        <div className="canvas-legend-colors" aria-hidden="true">
          {['#76b6f0', '#e7a676', '#9bcf7b', '#c49bea'].map((color) => (
            <span key={color} className="swatch" style={{ borderTopColor: color }} />
          ))}
        </div>
        <div>Arrow color = source module</div>
        <div>
          <span className="swatch" />
          verified dependency
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
