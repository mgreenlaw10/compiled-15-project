import { useEffect, useMemo } from 'react'
import { ReactFlow, Background, Controls, MarkerType, useNodesState, type Node, type Edge } from '@xyflow/react'
import { useStore } from '../../state/store'
import type { ModuleNode } from '../../../shared/types/architecture'
import { isCallable, isDataType } from '../../../shared/graph/program'
import { collapseFlowEdges, DependencyDetailEdge, underlyingFlowEdges } from './edges'
import { ProgramNodeView } from './ProgramNodeView'

const colors = { call: '#c08cf5', type: '#5fc6ae', field_read: '#e3ac67', field_write: '#e3ac67', contract: '#e482a7' }
const edgeTypes = { dependencyDetail: DependencyDetailEdge }
const nodeTypes = { program: ProgramNodeView }
export function ProgramCanvas({ module, file }: { module: ModuleNode; file?: string }): JSX.Element {
  const graph = useStore((s) => s.desired)!
  const layout = useStore((s) => s.layout)
  const setPosition = useStore((s) => s.setPosition)
  const openModule = useStore((s) => s.openModule)
  const openFile = useStore((s) => s.openFile)
  const back = useStore((s) => s.backToProject)
  const selectSymbol = useStore((s) => s.selectSymbol)
  const selectRelationship = useStore((s) => s.selectRelationship)
  const selectedSymbolId = useStore((s) => s.selectedSymbolId)
  const selectedFile = useStore((s) => s.selectedFile)
  const selectedNodeId = file ? selectedSymbolId : selectedSymbolId ?? selectedFile
  const computed = useMemo(() => {
    const symbolById = new Map(graph.program.symbols.map((s) => [s.id, s]))
    const symbols = graph.program.symbols.filter((s) => file ? s.source.file === file : module.files.includes(s.source.file))
    const ids = new Set(symbols.map((s) => s.id))
    const nodes: Node[] = []
    const edges: Edge[] = []
    if (!file) {
      module.files.forEach((name, i) => {
        const members = symbols.filter((s) => s.source.file === name)
        nodes.push({ id: name, position: layout.positions[`file:${name}`] ?? { x: (i % 3) * 300, y: Math.floor(i / 3) * 150 },
          type: 'program',
          data: { label: name.split('/').pop() ?? name, badge: 'file', tone: 'file',
            detail: `${name} · ${members.filter(isCallable).length} functions · ${members.filter(isDataType).length} types` },
          style: { width: 240 } })
      })
      const paired = new Set<string>()
      for (const relation of graph.program.relationships) {
        const from = symbolById.get(relation.fromSymbolId)?.source.file
        const to = symbolById.get(relation.toSymbolId ?? '')?.source.file
        if (!from || !to || from === to || !module.files.includes(from) || !module.files.includes(to)) continue
        const key = `${from}:${to}:${relation.kind}`
        if (paired.has(key)) continue
        paired.add(key)
        const color = colors[relation.kind as keyof typeof colors] ?? '#4d6a94'
        edges.push({ id: relation.id, source: from, target: to, label: relation.kind,
          style: { stroke: color, strokeDasharray: relation.resolution === 'resolved' ? undefined : '5 4' }, markerEnd: { type: MarkerType.ArrowClosed, color } })
      }
      for (const [i, relation] of graph.program.fileRelationships.entries()) {
        if (relation.fromFile === relation.toFile || !module.files.includes(relation.fromFile) || !module.files.includes(relation.toFile)) continue
        edges.push({ id: `file-relation:${i}`, source: relation.fromFile, target: relation.toFile, label: relation.kind, style: { stroke: '#4d6a94' } })
      }
      graph.program.contracts.filter((c) => c.moduleId === module.id && !c.symbolId).forEach((c, i) => nodes.push({
        id: `contract:${c.id}`, type: 'program', position: layout.positions[`file:contract:${c.id}`] ?? { x: 950, y: i * 125 },
        data: { label: c.category.replaceAll('_', ' '), badge: 'module contract', tone: 'contract',
          detail: `${c.expression ?? c.description} · ${c.provenance} · ${c.verification}` },
        style: { width: 210 }
      }))
    } else {
      const boundary = graph.program.relationships.filter((r) => ids.has(r.fromSymbolId) && r.toSymbolId && !ids.has(r.toSymbolId))
      const extra = [...new Set(boundary.map((r) => r.toSymbolId!))].map((id) => symbolById.get(id)).filter((s) => !!s)
      const all = [...symbols, ...extra]
      all.forEach((s, i) => nodes.push({ id: s.id, type: 'program', position: layout.positions[`symbol:${s.id}`] ?? { x: (i % 3) * 310, y: Math.floor(i / 3) * 150 },
        data: { label: s.name, badge: s.kind.replaceAll('_', ' '), tone: isDataType(s) ? 'type' : 'function',
          external: !ids.has(s.id),
          detail: `${s.qualifiedName} — ${s.signature} · ${s.accessibility} · ${s.source.file}:${s.source.line}` },
        style: { width: 210 } }))
      const fields = all.flatMap((s) => s.fields.map((f) => ({ ...f, owner: s })))
      fields.forEach((f, i) => nodes.push({ id: f.id, type: 'program', position: layout.positions[`symbol:${f.id}`] ?? { x: 950, y: i * 110 },
        data: { label: f.name, badge: 'field', tone: 'field',
          detail: `${f.owner.qualifiedName}.${f.name}: ${f.type} · ${f.accessibility} · ${f.source.file}:${f.source.line}` },
        style: { width: 190 } }))
      const nodeIds = new Set(nodes.map((s) => s.id))
      for (const r of graph.program.relationships.filter((r) => nodeIds.has(r.fromSymbolId) && r.toSymbolId && nodeIds.has(r.toSymbolId))) {
        if (r.kind === 'contract') continue
        const color = colors[r.kind as keyof typeof colors] ?? '#4d6a94'
        edges.push({ id: r.id, source: r.fromSymbolId, target: r.toFieldId && nodeIds.has(r.toFieldId) ? r.toFieldId : r.toSymbolId!, label: r.kind,
          style: { stroke: color, strokeDasharray: r.resolution !== 'resolved' ? '5 4' : undefined }, markerEnd: { type: MarkerType.ArrowClosed, color } })
      }
      const outgoing = graph.program.relationships.filter((r) => ids.has(r.fromSymbolId))
      const contractIds = new Set(outgoing.filter((r) => r.contractId).map((r) => r.contractId!))
      const contracts = graph.program.contracts.filter((c) => c.symbolId && ids.has(c.symbolId) || contractIds.has(c.id))
      contracts.forEach((c, i) => {
        nodes.push({ id: `contract:${c.id}`, type: 'program', position: layout.positions[`symbol:contract:${c.id}`] ?? { x: 1250, y: i * 125 },
          data: { label: c.category.replaceAll('_', ' '), badge: 'contract', tone: 'contract',
            detail: `${c.expression ?? c.description} · ${c.provenance} · ${c.verification}` },
          style: { width: 210 } })
        if (c.symbolId && nodeIds.has(c.symbolId)) edges.push({ id: `contract:${c.id}`, source: c.fieldId ?? c.symbolId, target: `contract:${c.id}`, label: 'specification', style: { stroke: '#e482a7', strokeDasharray: '5 4' } })
      })
      for (const r of outgoing.filter((r) => r.contractId)) edges.push({ id: r.id, source: r.fromSymbolId, target: `contract:${r.contractId}`, label: 'contract reliance',
        style: { stroke: '#e482a7', strokeDasharray: r.resolution === 'resolved' ? undefined : '5 4' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#e482a7' } })
      const unresolved = outgoing.filter((r) => r.resolution === 'unresolved' && !r.contractId)
      const unknownIds = new Set<string>()
      for (const r of unresolved) {
        const id = `unresolved:${r.fromSymbolId}:${r.targetName}`
        if (!unknownIds.has(id)) {
          nodes.push({ id, type: 'program', position: layout.positions[`symbol:${id}`] ?? { x: 1550, y: unknownIds.size * 100 },
            data: { label: r.targetName, badge: `unresolved ${r.kind}`, tone: 'unresolved', external: true,
              detail: `Unresolved ${r.kind} of ${r.targetName}` },
            style: { width: 200 } })
          unknownIds.add(id)
        }
        edges.push({ id: r.id, source: r.fromSymbolId, target: id, label: r.kind, style: { stroke: '#8b93a3', strokeDasharray: '5 4' } })
      }
    }
    return { nodes, edges }
  }, [graph, module, file, layout.positions])
  const displayedNodes = useMemo(() => computed.nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId })), [computed.nodes, selectedNodeId])
  const displayedEdges = useMemo(() => collapseFlowEdges(computed.edges, selectedNodeId), [computed.edges, selectedNodeId])
  const [nodes, setNodes, onNodesChange] = useNodesState(displayedNodes)
  useEffect(() => setNodes(displayedNodes), [displayedNodes, setNodes])
  const selectNode = (id: string): void => {
    if (file || id.startsWith('contract:')) selectSymbol(id)
    else useStore.getState().selectFile(id)
  }
  const contracts = graph.program.contracts.filter((c) => module.components.contracts.contractIds.includes(c.id))
  return <div className="canvas-wrap">
    <div className="program-breadcrumbs" aria-label="Graph navigation">
      <button className="btn btn--sm" onClick={back}>{graph.name}</button><span>›</span>
      <button className="btn btn--sm" onClick={() => openModule(module.id)}>{module.name}</button>
      {file && <><span>›</span><span className="mono">{file}</span></>}
      <span className="hint">{file ? 'Source structure' : 'Module structure'} · {contracts.length} contracts</span>
    </div>
    <ReactFlow key={`${module.id}:${file ?? ''}`} nodes={nodes} edges={displayedEdges} edgeTypes={edgeTypes} nodeTypes={nodeTypes} onNodesChange={onNodesChange} fitView
      onNodeClick={(_event, node) => selectNode(node.id)}
      onNodeDoubleClick={(_event, node) => {
        if (node.id.startsWith('contract:')) return
        if (!file) openFile(module.id, node.id)
        else { const symbol = graph.program.symbols.find((s) => s.id === node.id); const owner = graph.modules.find((m) => symbol && m.files.includes(symbol.source.file)); if (symbol && owner) openFile(owner.id, symbol.source.file) }
      }}
      onEdgeClick={(_event, edge) => {
        const underlying = underlyingFlowEdges(computed.edges, edge)
        if (!underlying.length) return
        if (!selectedNodeId || ![edge.source, edge.target].includes(selectedNodeId)) selectNode(underlying[0].source)
        selectRelationship(underlying.length === 1 ? underlying[0].id : `references:${JSON.stringify(underlying.map((e) => e.id))}`)
      }}
      onPaneClick={() => {
        useStore.getState().select(module.id)
        if (file) useStore.getState().selectFile(file)
      }}
      onNodeDragStop={(_event, node) => setPosition(`${file ? 'symbol' : 'file'}:${node.id}`, node.position)}
      nodesConnectable={false} deleteKeyCode={null} colorMode="dark" proOptions={{ hideAttribution: true }}>
      <Background gap={22} /><Controls showInteractive={false} />
    </ReactFlow>
    <div className="program-hint">{file ? 'Select a node for its properties and dependency details.' : 'Select a file for details; double-click to open it.'} Click the canvas to collapse arrows.</div>
  </div>
}
