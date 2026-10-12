import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import path from 'node:path'
import { analyzeProject } from '../../src/core/analyzer'
import { GraphCanvas } from '../../src/renderer/features/canvas/GraphCanvas'
import { Inspector } from '../../src/renderer/features/inspector/Inspector'
import { useStore } from '../../src/renderer/state/store'
import { installFakeApi } from './fake-api'

beforeEach(async () => {
  installFakeApi()
  const analyzed = await analyzeProject(path.resolve(__dirname, '../../examples/program-graph/java'))
  const account = analyzed.graph.modules.find((m) => m.files.includes('api/Account.java'))!
  useStore.setState({ original: analyzed.graph, desired: analyzed.graph, layout: analyzed.layout,
    selectedModuleId: account.id, selectedSymbolId: null, selectedRelationshipId: null,
    selectedFile: null, viewScope: null, operations: [], appliedOperationIds: [], dirty: false,
    settings: null, error: null })
})
afterEach(() => cleanup())

it('opens module and source subgraphs with breadcrumbs without recording a source operation', () => {
  const rendered = render(<><GraphCanvas /><Inspector /></>)
  fireEvent.click(screen.getByRole('button', { name: 'Open module structure' }))
  expect(useStore.getState().viewScope?.moduleId).toBe(useStore.getState().selectedModuleId)
  expect(screen.getByLabelText('Graph navigation')).toBeTruthy()
  const node = rendered.container.querySelector('[data-id="api/Account.java"]')!
  expect(node).toBeTruthy()
  fireEvent.doubleClick(node)
  expect(useStore.getState().viewScope?.file).toBe('api/Account.java')
  expect(screen.getByText(/Source structure · \d+ contracts/)).toBeTruthy()
  const graph = useStore.getState().desired!
  const withdraw = graph.program.symbols.find((s) => s.qualifiedName === 'bank.Account.withdraw')!
  expect(rendered.container.querySelector(`[data-id="${withdraw.id}"]`)).toBeTruthy()
  const nav = screen.getByLabelText('Graph navigation')
  fireEvent.click(within(nav).getByRole('button', { name: graph.name }))
  expect(useStore.getState().viewScope).toBeNull()
  expect(useStore.getState().operations).toEqual([])
})

it('shows the component sections of the selected module', () => {
  render(<Inspector />)
  for (const name of [
    'Responsibilities',
    'Interface Functions',
    'Data Structures',
    'Private Implementation'
  ]) {
    expect(screen.getByText(name)).toBeTruthy()
  }
  // Contract authoring was removed from the module inspector; contracts are
  // still shown and edited by selecting a contract node.
  expect(screen.queryByText('Module Contracts')).toBeNull()
  expect(screen.queryByText('Add behavioral contract')).toBeNull()
})

it('records a user contract as a pending structured edit', () => {
  render(<Inspector />)
  const observedCount = useStore.getState().original!.program.contracts.length
  const symbol = useStore.getState().desired!.program.symbols.find((s) => s.name === 'withdraw')!
  const moduleId = useStore.getState().selectedModuleId!

  act(() => {
    useStore.getState().dispatchOperation({
      type: 'add_contract',
      moduleId,
      contract: {
        id: 'contract:user-daily-limit',
        moduleId,
        symbolId: symbol.id,
        category: 'precondition',
        description: 'Reject withdrawals above the daily limit',
        expression: 'amount <= 500',
        provenance: 'user_specified',
        verification: 'unverified',
        verificationNote: 'Pending user specification.',
        evidence: [],
        version: 1
      }
    })
  })

  const state = useStore.getState()
  expect(state.operations.at(-1)?.type).toBe('add_contract')
  expect(state.desired!.program.contracts.at(-1)).toMatchObject({
    symbolId: symbol.id,
    provenance: 'user_specified',
    verification: 'unverified'
  })
  // The observed graph is never edited by a user contract.
  expect(state.original!.program.contracts).toHaveLength(observedCount)
})

it.each([
  ['Add interface function', 'Interface Function', true, false],
  ['Add data structure', 'Data Structure', true, true],
  ['Add private implementation', 'Private Implementation', false, false]
])('opens properties immediately from %s without requiring a signature', (button, title, publicApi, dataType) => {
  const observed = useStore.getState().original!
  const rendered = render(<Inspector />)
  expect(screen.queryByText('Add function or data structure')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: String(button) }))
  const inspector = within(rendered.container.querySelector('.pane--right') as HTMLElement)
  expect(inspector.getByText(String(title))).toBeTruthy()
  const description = inspector.getByLabelText('Description')
  expect(document.activeElement).toBe(description)
  const suggestion = inspector.getByLabelText('Suggested signature (optional)')
  expect(suggestion).toHaveProperty('value', '')
  expect(suggestion.hasAttribute('required')).toBe(false)
  const id = useStore.getState().selectedSymbolId!
  const draft = useStore.getState().desired!.program.symbols.find((s) => s.id === id)!
  expect(draft.publiclyAccessible).toBe(publicApi)
  expect(draft.description).toBe('')
  expect(draft.sourceText).toBe('')
  expect(draft.signature).toBe('')
  if (dataType) expect(inspector.getByLabelText('Data structure kind')).toBeTruthy()
  else expect(inspector.getByRole('button', { name: 'Add parameter' })).toBeTruthy()
  fireEvent.change(description, { target: { value: 'Validate payment inputs and return a useful error for invalid values.' } })
  fireEvent.blur(description)
  expect(useStore.getState().desired!.program.symbols.find((s) => s.id === id)?.description).toContain('Validate payment')
  expect(useStore.getState().original).toBe(observed)
  expect(useStore.getState().operations[0].type).toBe('add_symbol')
  expect(useStore.getState().operations.at(-1)?.type).toBe('update_symbol')
})

it('edits an assertion contract and displays potential consumer impact while preserving observed facts', () => {
  const state = useStore.getState()
  const contract = state.original!.program.contracts.find((c) => c.enforcement && state.original!.program.symbols.find((s) => s.id === c.symbolId)?.name === 'withdraw')!
  // Contracts are inspected by selecting the contract node; the module
  // inspector no longer lists them.
  act(() => useStore.getState().selectSymbol(`contract:${contract.id}`))
  render(<Inspector />)
  const card = screen.getByTestId(`contract-${contract.id}`)
  fireEvent.click(within(card).getByText(/precondition · bank.Account.withdraw/))
  const input = within(card).getByLabelText('Contract expression')
  fireEvent.change(input, { target: { value: 'amount > 10' } })
  fireEvent.blur(input)
  expect(useStore.getState().operations.at(-1)?.type).toBe('modify_contract')
  expect(screen.getByText('Pending Change Impact')).toBeTruthy()
  expect(screen.getAllByText(/reliance on this guarantee is potential/i).length).toBeGreaterThan(0)
  expect(useStore.getState().original!.program.contracts.find((c) => c.id === contract.id)?.expression).toBe('amount > 0')
})

it('shows exact symbol evidence and lexical assumptions for a selected call dependency', () => {
  const graph = useStore.getState().desired!
  const relation = graph.program.relationships.find((r) => r.kind === 'call' && r.targetName === 'bank.Account.withdraw')!
  act(() => useStore.getState().selectRelationship(relation.id))
  render(<Inspector />)
  expect(screen.getByText('Dependency evidence')).toBeTruthy()
  expect(screen.getByText(/call: bank.Account.withdraw \(resolved\)/)).toBeTruthy()
  expect(screen.getByText(/runtime overrides and indirect dispatch are not established/)).toBeTruthy()
})

it('shows only the selected function and keeps its edits pending', () => {
  const graph = useStore.getState().desired!
  const symbol = graph.program.symbols.find((s) => s.name === 'withdraw')!
  const owner = graph.modules.find((m) => m.files.includes(symbol.source.file))!
  act(() => useStore.getState().openFile(owner.id, symbol.source.file))
  const rendered = render(<><GraphCanvas /><Inspector /></>)
  fireEvent.click(rendered.container.querySelector(`[data-id="${symbol.id}"]`)!)
  const inspector = within(rendered.container.querySelector('.pane--right') as HTMLElement)
  expect(inspector.getByLabelText('Symbol name')).toHaveProperty('value', 'withdraw')
  expect(inspector.getByLabelText('Parameter 1 type')).toHaveProperty('value', 'int')
  expect(inspector.queryByText('Responsibilities')).toBeNull()
  expect(inspector.queryByText('Interface Functions')).toBeNull()
  expect(inspector.queryByLabelText('Directory')).toBeNull()
  const type = inspector.getByLabelText('Parameter 1 type')
  fireEvent.change(type, { target: { value: 'String' } })
  fireEvent.blur(type)
  expect(useStore.getState().operations.at(-1)).toMatchObject({ type: 'update_symbol', symbolId: symbol.id })
  expect(useStore.getState().original!.program.symbols.find((s) => s.id === symbol.id)?.parameters[0].type).toBe('int')
  expect(useStore.getState().desired!.program.symbols.find((s) => s.id === symbol.id)?.parameters[0].type).toBe('String')
})

it('shows a type or exact field without unrelated module controls', () => {
  const graph = useStore.getState().desired!
  const type = graph.program.symbols.find((s) => s.name === 'Account')!
  const owner = graph.modules.find((m) => m.files.includes(type.source.file))!
  act(() => useStore.getState().openFile(owner.id, type.source.file))
  const rendered = render(<><GraphCanvas /><Inspector /></>)
  fireEvent.click(rendered.container.querySelector(`[data-id="${type.id}"]`)!)
  let inspector = within(rendered.container.querySelector('.pane--right') as HTMLElement)
  expect(inspector.getByLabelText('Symbol name')).toHaveProperty('value', 'Account')
  expect(inspector.getByLabelText('Field name')).toHaveProperty('value', 'balance')
  expect(inspector.queryByText('Responsibilities')).toBeNull()
  fireEvent.click(rendered.container.querySelector(`[data-id="${type.fields[0].id}"]`)!)
  inspector = within(rendered.container.querySelector('.pane--right') as HTMLElement)
  expect(useStore.getState().selectedSymbolId).toBe(type.fields[0].id)
  expect(inspector.getByText('Field')).toBeTruthy()
  expect(inspector.getByLabelText('Field name')).toHaveProperty('value', 'balance')
  expect(inspector.queryByLabelText('Symbol name')).toBeNull()
  expect(inspector.queryByLabelText('Source signature')).toBeNull()
  const fieldType = inspector.getByLabelText('Field type')
  fireEvent.change(fieldType, { target: { value: 'long' } })
  fireEvent.blur(fieldType)
  expect(useStore.getState().desired!.program.symbols.find((s) => s.id === type.id)?.fields[0].type).toBe('long')
  expect(useStore.getState().original!.program.symbols.find((s) => s.id === type.id)?.fields[0].type).toBe('int')
})

it('focuses a contract node and returns to module properties on request', () => {
  const graph = useStore.getState().desired!
  const symbol = graph.program.symbols.find((s) => s.name === 'withdraw')!
  const owner = graph.modules.find((m) => m.files.includes(symbol.source.file))!
  const contract = graph.program.contracts.find((c) => c.symbolId === symbol.id && c.enforcement)!
  act(() => useStore.getState().openFile(owner.id, symbol.source.file))
  const rendered = render(<><GraphCanvas /><Inspector /></>)
  fireEvent.click(rendered.container.querySelector(`[data-id="contract:${contract.id}"]`)!)
  const inspector = within(rendered.container.querySelector('.pane--right') as HTMLElement)
  expect(inspector.getAllByTestId(/^contract-/)).toHaveLength(1)
  expect(inspector.getByLabelText('Contract expression')).toHaveProperty('value', contract.expression)
  expect(inspector.queryByText('Module Contracts')).toBeNull()
  expect(inspector.queryByLabelText('Symbol name')).toBeNull()
  fireEvent.click(inspector.getByRole('button', { name: `Module details: ${owner.name}` }))
  expect(screen.getByText('Responsibilities')).toBeTruthy()
  expect(useStore.getState().viewScope?.file).toBe(symbol.source.file)
  expect(useStore.getState().operations).toEqual([])
})

it('inspects a boundary symbol in its actual module without changing the open file', () => {
  const graph = useStore.getState().desired!
  const source = graph.modules.find((m) => m.files.includes('services/PaymentService.java'))!
  const target = graph.program.symbols.find((s) => s.name === 'withdraw')!
  act(() => useStore.getState().openFile(source.id, 'services/PaymentService.java'))
  const rendered = render(<><GraphCanvas /><Inspector /></>)
  fireEvent.click(rendered.container.querySelector(`[data-id="${target.id}"]`)!)
  const inspector = within(rendered.container.querySelector('.pane--right') as HTMLElement)
  expect(inspector.getByLabelText('Symbol name')).toHaveProperty('value', 'withdraw')
  expect(useStore.getState().selectedModuleId).toBe(graph.modules.find((m) => m.files.includes(target.source.file))!.id)
  expect(useStore.getState().viewScope).toEqual({ moduleId: source.id, file: 'services/PaymentService.java' })
  expect(inspector.queryByText('Responsibilities')).toBeNull()
  expect(useStore.getState().operations).toEqual([])
})

it('shows file information after selecting a file node, and clears that focus on returning to the project', () => {
  const owner = useStore.getState().desired!.modules.find((m) => m.files.includes('api/Account.java'))!
  act(() => useStore.getState().openModule(owner.id))
  const rendered = render(<><GraphCanvas /><Inspector /></>)
  fireEvent.click(rendered.container.querySelector('[data-id="api/Account.java"]')!)
  expect(screen.getByText('File symbols')).toBeTruthy()
  expect(screen.queryByText('Responsibilities')).toBeNull()
  act(() => useStore.getState().backToProject())
  expect(screen.getByText('Responsibilities')).toBeTruthy()
  expect(useStore.getState().selectedFile).toBeNull()
  expect(useStore.getState().operations).toEqual([])
})

it('shows source evidence for an unresolved node without inventing a declaration or opening the module editor', () => {
  const graph = useStore.getState().desired!
  const relation = graph.program.relationships.find((r) => r.resolution === 'unresolved' && r.source.file === 'api/Account.java')!
  const owner = graph.modules.find((m) => m.files.includes(relation.source.file))!
  act(() => useStore.getState().openFile(owner.id, relation.source.file))
  const rendered = render(<><GraphCanvas /><Inspector /></>)
  const node = rendered.container.querySelector(`[data-id="unresolved:${relation.fromSymbolId}:${relation.targetName}"]`)!
  fireEvent.click(node)
  const inspector = within(rendered.container.querySelector('.pane--right') as HTMLElement)
  expect(inspector.getByText('Unresolved reference')).toBeTruthy()
  expect(inspector.getAllByText(/No analyzed declaration can be bound/).length).toBeGreaterThan(0)
  expect(inspector.queryByLabelText('Symbol name')).toBeNull()
  expect(inspector.queryByText('Responsibilities')).toBeNull()
  expect(useStore.getState().operations).toEqual([])
})
