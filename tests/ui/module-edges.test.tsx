import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactFlowProps } from '@xyflow/react'
import path from 'node:path'
import { analyzeProject } from '../../src/core/analyzer'
import { createEdge, createGraph, createLayout, createModule } from '../../src/shared/graph/model'
import { collapseFlowEdges, toModuleFlowEdges, underlyingDependencies } from '../../src/renderer/features/canvas/edges/module-edges'
import { GraphCanvas } from '../../src/renderer/features/canvas/GraphCanvas'
import { ProgramCanvas } from '../../src/renderer/features/canvas/ProgramCanvas'
import { Inspector } from '../../src/renderer/features/inspector/Inspector'
import { useStore } from '../../src/renderer/state/store'

// Observe canvas wiring without relying on jsdom to measure SVG handle positions.
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ReactFlow: (props: ReactFlowProps) => <div>
    <button onClick={(event) => props.onPaneClick?.(event)}>Canvas background</button>
    {props.nodes?.map((node) => <button key={node.id} onClick={(event) => props.onNodeClick?.(event, node)}>Module {node.id}</button>)}
    <div data-testid="displayed-edges">{props.edges?.map((edge) => <div key={edge.id} data-edge-id={edge.id} data-source={edge.source} data-target={edge.target} data-overview={edge.data?.overview ? 'yes' : 'no'}>
      <button onClick={(event) => props.onEdgeClick?.(event, edge)}>{edge.id}</button>
      <button onClick={() => props.onEdgesDelete?.([edge])}>Delete {edge.id}</button>
    </div>)}</div>
  </div>
}))

const dependencies = [
  createEdge({ from: 'a', to: 'b', kind: 'imports', verified: true }),
  createEdge({ from: 'a', to: 'b', kind: 'calls', verified: true }),
  createEdge({ from: 'a', to: 'b', kind: 'types', verified: false }),
  createEdge({ from: 'b', to: 'a', kind: 'fields', verified: true }),
  createEdge({ from: 'c', to: 'd', kind: 'calls', verified: true }),
  createEdge({ from: 'c', to: 'd', kind: 'contracts', verified: true })
]

beforeEach(() => {
  const graph = createGraph({ projectRoot: 'fixture', name: 'Modules', modules: ['a', 'b', 'c', 'd'].map((id) => createModule({ id, name: id })), edges: dependencies })
  useStore.setState({ original: graph, desired: graph, layout: createLayout(), selectedModuleId: null,
    selectedFile: null, selectedSymbolId: null, selectedRelationshipId: null, viewScope: null,
    operations: [], appliedOperationIds: [], dirty: false, error: null })
})
afterEach(cleanup)

it('collapses every module pair to one unlabeled arrow and preserves direction and uncertainty', () => {
  const edges = toModuleFlowEdges(dependencies, null)
  expect(edges).toHaveLength(2)
  const mutual = edges.find((edge) => edge.source === 'a')!
  expect(mutual.label).toBeUndefined()
  expect(mutual.markerStart).toBeTruthy()
  expect(mutual.markerEnd).toBeTruthy()
  expect(mutual.style?.strokeDasharray).toBe('5 4')
  expect(mutual.deletable).toBe(false)
  expect(underlyingDependencies(dependencies, mutual.id)).toEqual(dependencies.slice(0, 4))
  const oneWay = edges.find((edge) => edge.source === 'c')!
  expect(oneWay.target).toBe('d')
  expect(oneWay.markerStart).toBeUndefined()
  expect(oneWay.style?.strokeDasharray).toBeUndefined()
})

it('reveals all incoming and outgoing dependency kinds only for the selected module', () => {
  const edges = toModuleFlowEdges(dependencies, 'a')
  const details = edges.filter((edge) => edge.type === 'dependencyDetail')
  expect(details.map((edge) => edge.id).sort()).toEqual(dependencies.slice(0, 4).map((edge) => edge.id).sort())
  expect(new Set(details.map((edge) => edge.data?.offset)).size).toBe(4)
  expect(details.every((edge) => edge.label)).toBe(true)
  const overview = edges.filter((edge) => edge.data?.overview)
  expect(overview).toHaveLength(1)
  expect(overview[0].source).toBe('c')
  expect(overview[0].style?.opacity).toBeLessThan(1)
})

it('expands on selection and collapses on background click without changing architectural facts', () => {
  const observed = useStore.getState().original
  render(<GraphCanvas />)
  const edges = screen.getByTestId('displayed-edges')
  expect(edges.children).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Module a' }))
  expect(edges.children).toHaveLength(5)
  expect(edges.querySelectorAll('[data-overview="no"]')).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: 'Canvas background' }))
  expect(edges.children).toHaveLength(2)
  expect(edges.querySelectorAll('[data-overview="yes"]')).toHaveLength(2)
  expect(useStore.getState().desired).toBe(observed)
  expect(useStore.getState().operations).toEqual([])
  expect(useStore.getState().dirty).toBe(false)
})

it('opens real dependency evidence when clicking an overview and keeps the selected endpoint highlighted', () => {
  render(<GraphCanvas />)
  const edges = screen.getByTestId('displayed-edges')
  fireEvent.click(within(edges).getByRole('button', { name: 'module-pair:a:b' }))
  expect(useStore.getState().selectedModuleId).toBe('a')
  expect(useStore.getState().selectedRelationshipId).toBe(dependencies[0].id)
  fireEvent.click(within(edges).getByRole('button', { name: dependencies[3].id }))
  expect(useStore.getState().selectedModuleId).toBe('a')
  expect(useStore.getState().selectedRelationshipId).toBe(dependencies[3].id)
  expect(useStore.getState().operations).toEqual([])
})

it('ignores summary deletion and removes only the chosen real dependency kind', () => {
  render(<GraphCanvas />)
  const edges = screen.getByTestId('displayed-edges')
  fireEvent.click(within(edges).getByRole('button', { name: 'Delete module-pair:a:b' }))
  expect(useStore.getState().operations).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Module a' }))
  fireEvent.click(within(edges).getByRole('button', { name: `Delete ${dependencies[1].id}` }))
  expect(useStore.getState().operations.at(-1)).toMatchObject({ type: 'remove_dependency', from: 'a', to: 'b', kind: 'calls' })
  expect(useStore.getState().desired!.edges.some((edge) => edge.id === dependencies[0].id)).toBe(true)
  expect(useStore.getState().desired!.edges.some((edge) => edge.id === dependencies[3].id)).toBe(true)
})

it('collapses file arrows and reveals only the selected file connections', async () => {
  const analyzed = await analyzeProject(path.resolve(__dirname, '../../examples/program-graph/c'))
  const graph = analyzed.graph
  const module = graph.modules.find((m) => m.files.includes('implementation/account.c'))!
  useStore.setState({ original: graph, desired: graph, layout: analyzed.layout })
  useStore.getState().openModule(module.id)
  render(<><ProgramCanvas module={module} /><Inspector /></>)
  const edges = screen.getByTestId('displayed-edges')
  expect(edges.children).toHaveLength(1)
  expect(edges.querySelectorAll('[data-overview="yes"]')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Module implementation/account.c' }))
  expect(screen.getByText('File symbols')).toBeTruthy()
  const details = [...edges.querySelectorAll('[data-overview="no"]')]
  expect(details.length).toBeGreaterThan(1)
  expect(details.every((edge) => edge.getAttribute('data-source') === 'implementation/account.c' || edge.getAttribute('data-target') === 'implementation/account.c')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Canvas background' }))
  expect(edges.children).toHaveLength(1)
  expect(screen.getByText('Overall Description')).toBeTruthy()
  expect(useStore.getState().desired).toBe(graph)
  expect(useStore.getState().operations).toEqual([])
})

it('reveals function or field arrows without expanding unrelated pairs, and keeps source context when cleared', async () => {
  const analyzed = await analyzeProject(path.resolve(__dirname, '../../examples/program-graph/c'))
  const graph = analyzed.graph
  const module = graph.modules.find((m) => m.files.includes('implementation/account.c'))!
  const symbol = graph.program.symbols.find((s) => s.name === 'account_withdraw' && s.definition)!
  const structure = graph.program.symbols.find((s) => s.name === 'Account' && s.kind === 'struct')!
  useStore.setState({ original: graph, desired: graph, layout: analyzed.layout })
  useStore.getState().openFile(module.id, symbol.source.file)
  render(<><ProgramCanvas module={module} file={symbol.source.file} /><Inspector /></>)
  const edges = screen.getByTestId('displayed-edges')
  expect(edges.querySelectorAll('[data-overview="no"]')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: `Module ${symbol.id}` }))
  let details = [...edges.querySelectorAll('[data-overview="no"]')]
  expect(details.length).toBeGreaterThan(1)
  expect(details.every((edge) => edge.getAttribute('data-source') === symbol.id || edge.getAttribute('data-target') === symbol.id)).toBe(true)
  expect(screen.queryByText('Overall Description')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: `Module ${structure.fields[0].id}` }))
  details = [...edges.querySelectorAll('[data-overview="no"]')]
  expect(details.length).toBeGreaterThan(1)
  expect(details.every((edge) => edge.getAttribute('data-source') === structure.fields[0].id || edge.getAttribute('data-target') === structure.fields[0].id)).toBe(true)
  expect(screen.getByLabelText('Field name')).toHaveProperty('value', 'balance')
  fireEvent.click(screen.getByRole('button', { name: 'Canvas background' }))
  expect(edges.querySelectorAll('[data-overview="no"]')).toHaveLength(0)
  expect(screen.getByText('File symbols')).toBeTruthy()
  expect(useStore.getState().viewScope).toEqual({ moduleId: module.id, file: symbol.source.file })
  expect(useStore.getState().operations).toEqual([])
})

it('opens actual source evidence from a collapsed file arrow', async () => {
  const analyzed = await analyzeProject(path.resolve(__dirname, '../../examples/program-graph/c'))
  const module = analyzed.graph.modules.find((m) => m.files.includes('implementation/account.c'))!
  useStore.setState({ original: analyzed.graph, desired: analyzed.graph, layout: analyzed.layout })
  useStore.getState().openModule(module.id)
  render(<><ProgramCanvas module={module} /><Inspector /></>)
  const overview = screen.getByTestId('displayed-edges').children[0]
  fireEvent.click(within(overview as HTMLElement).getAllByRole('button')[0])
  expect(screen.getAllByText('Dependency evidence').length).toBeGreaterThan(0)
  expect(useStore.getState().selectedRelationshipId).toMatch(/^references:/)
  expect(screen.queryByText('Overall Description')).toBeNull()
  expect(useStore.getState().operations).toEqual([])
})

it('keeps recursive source dependencies visible in both overview and selected detail', () => {
  const recursive = [{ id: 'recursion', source: 'fn', target: 'fn', label: 'call', data: { verified: true } }]
  const overview = collapseFlowEdges(recursive, null)
  expect(overview).toHaveLength(1)
  expect(overview[0].data?.overview).toBe(true)
  const detail = collapseFlowEdges(recursive, 'fn')
  expect(detail).toHaveLength(1)
  expect(detail[0].id).toBe('recursion')
  expect(detail[0].data?.offset).toBeGreaterThan(0)
})
