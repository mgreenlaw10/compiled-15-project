/**
 * The architecture canvas.
 *
 * Pan, zoom, drag, select, connect and disconnect. The important distinction
 * this component enforces is the one the brief calls for: dragging a node
 * writes to `layout` only, while drawing or deleting an edge records a
 * *structural* operation. Position changes can never trigger a code change.
 *
 * Two things it deliberately does not own:
 *
 *   - **How edges look** — `./edges/edge-style.ts`, including the legend.
 *   - **What right-click offers** — `./context-menu/items.ts`.
 *
 * Both are wired in below and extended in their own directories, so recolouring
 * an arrow or adding a menu item does not mean editing this file.
 */

import { useCallback, useEffect, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
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

import { supportedLanguagesSentence } from '../../../shared/languages'
import { useModulesWithPendingChanges, useStore } from '../../state/store'
import { ContextMenu, useContextMenu } from './context-menu'
import {
  EdgeLegend,
  NODE_COLOR,
  PENDING_NODE_COLOR,
  toFlowEdge
} from './edges'
import {
  ModuleNodeView,
  type FileDragPayload,
  type ModuleNodeData
} from './ModuleNodeView'

const nodeTypes = { module: ModuleNodeView }

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
  const menu = useContextMenu()

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

    return { nodes: nextNodes, edges: graph.edges.map(toFlowEdge) }
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
            Choose <strong>Open Project</strong> to pick a codebase. Cartograph
            will read it, work out its modules, and draw the architecture here.
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
        {...menu.handlers}
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
            pending.has(node.id) ? PENDING_NODE_COLOR : NODE_COLOR
          }
          maskColor="rgba(20, 22, 26, 0.72)"
        />
      </ReactFlow>

      {graph.modules.length === 0 ? (
        <div className="canvas-hint">
          <p>
            No modules were found. Cartograph currently reads{' '}
            {supportedLanguagesSentence()} — check that the project has source
            files outside
            <code> node_modules</code>, or add a module by hand.
          </p>
        </div>
      ) : null}

      <EdgeLegend />

      {menu.target ? (
        <ContextMenu target={menu.target} onClose={menu.close} />
      ) : null}
    </div>
  )
}
