/**
 * UI tests.
 *
 * These render the real application against the real analyzer and
 * transformation engine, with only Electron's IPC hop replaced. They are the
 * proof that the pipeline is reachable from the interface: open a project, see
 * the module graph, make a structural change, generate, and read the results —
 * all through the components a user clicks on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { App } from '../../src/renderer/app/App'
import { useStore } from '../../src/renderer/state/store'
import { createLayout } from '../../src/shared/graph/model'
import { installFakeApi, SAMPLE_PROJECT } from './fake-api'

const scratch: string[] = []

function resetStore(): void {
  useStore.setState({
    project: null,
    fileTree: null,
    original: null,
    desired: null,
    layout: createLayout(),
    operations: [],
    appliedOperationIds: [],
    selectedModuleId: null,
    selectedFile: null,
    selectedOperationId: null,
    deskMode: 'review',
    focusConnections: false,
    dialog: null,
    addModulePosition: null,
    busy: 'idle',
    error: null,
    notice: null,
    dirty: false,
    logs: [],
    bottomTab: 'preview',
    changeSet: null,
    diffs: null,
    applyResult: null,
    validation: null,
    settings: null
  })
}

beforeEach(() => {
  resetStore()
  installFakeApi()
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const dir of scratch.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** Opens the sample project through the store, as the toolbar button does. */
async function openSample(): Promise<void> {
  await act(async () => {
    await useStore.getState().openProject()
  })
  await waitFor(() => {
    expect(useStore.getState().desired?.modules.length ?? 0).toBeGreaterThan(0)
  })
}

describe('the application shell', () => {
  it('starts with no project and explains what to do', async () => {
    render(<App />)

    expect(screen.getByText('Cartograph')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Project' })).toBeTruthy()
    // Both the status bar and the canvas say so.
    expect(screen.getAllByText(/No project open/i).length).toBeGreaterThan(1)
    expect(screen.getByText(/Open a project to begin/i)).toBeTruthy()

    // Nothing to generate yet, so the action is disabled rather than lying.
    const generate = screen.getByRole('button', { name: 'Generate plan' })
    expect(generate.hasAttribute('disabled')).toBe(true)

    // No key configured: the toolbar says so, and the app still works.
    expect(screen.getByText('no api key')).toBeTruthy()
    await waitFor(() => expect(useStore.getState().settings).not.toBeNull())
  })

  it('shows the analyzed module graph and the file-to-module mapping', async () => {
    render(<App />)
    await openSample()

    // The project pane reports what was analyzed.
    expect((await screen.findAllByText('shop-api')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    fireEvent.click(screen.getByText('Project information'))
    expect(screen.getByText(/source files?,/)).toBeTruthy()

    // Module nodes are on the canvas, and the module list lists them.
    await waitFor(() => {
      expect(document.querySelectorAll('.module-node').length).toBeGreaterThan(4)
    })
    const nodeNames = [...document.querySelectorAll('.module-node .node-name')].map(
      (el) => el.textContent
    )
    expect(nodeNames).toContain('Auth')
    expect(nodeNames).toContain('Db')

    // Status bar states that the graph matches the code.
    expect(screen.getByText('Graph matches the source code')).toBeTruthy()
    expect(screen.getByText(/\d+ verified/)).toBeTruthy()

    // The explorer labels each source file with its owning module.
    const explorer = screen.getByText('Project explorer').closest('.pane-section')!
    expect(within(explorer as HTMLElement).getAllByText('Auth').length).toBeGreaterThan(0)
  })

  it('inspects a module and shows which edits are structural', async () => {
    render(<App />)
    await openSample()

    const auth = useStore.getState().desired!.modules.find((m) => m.name === 'Auth')!
    await act(async () => {
      useStore.getState().select(auth.id)
    })

    // The inspector shows the source mapping and the public interface.
    expect(await screen.findByDisplayValue('Auth')).toBeTruthy()
    expect(screen.getByDisplayValue('src/auth')).toBeTruthy()
    expect(screen.getByText('src/auth/session.ts')).toBeTruthy()
    // Listed both as part of the public interface and as a declaration.
    expect(screen.getAllByText('createSession').length).toBeGreaterThan(1)

    // The two kinds of edit are labelled differently, in words.
    expect(
      screen.getByText(/Documentation only — renaming a module never changes code/i)
    ).toBeTruthy()
    expect(
      screen.getByText(/Structural\. Changing this moves 5 files on disk/i)
    ).toBeTruthy()
  })

  it('treats dragging a node as visual only', async () => {
    render(<App />)
    await openSample()

    const before = useStore.getState().operations.length
    await act(async () => {
      useStore.getState().setPosition(useStore.getState().desired!.modules[0].id, {
        x: 42,
        y: 99
      })
    })

    // No operation recorded, so nothing can reach the source code.
    expect(useStore.getState().operations.length).toBe(before)
    expect(screen.getByText('Graph matches the source code')).toBeTruthy()
    expect(useStore.getState().layout.positions[
      useStore.getState().desired!.modules[0].id
    ]).toEqual({ x: 42, y: 99 })
  })
})

describe('canvas context actions and connection focus', () => {
  it('colors rendered arrows by source, preserves declared dashes and supports arrow actions', async () => {
    // Supply the measurements that a real browser gives React Flow so it can
    // render actual SVG arrows, rather than testing a mocked canvas.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120)
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: (entries: { target: Element; contentRect: DOMRect }[]) => void) {}
      observe(target: Element): void {
        queueMicrotask(() => this.callback([{ target, contentRect: new DOMRect(0, 0, 240, 120) }]))
      }
      unobserve(): void {}
      disconnect(): void {}
    })
    render(<App />)
    await openSample()
    const graph = useStore.getState().desired!
    await waitFor(() => expect(document.querySelectorAll('.react-flow__edge-path').length).toBe(graph.edges.length))
    const colors = new Set<string>()
    for (const edge of graph.edges) {
      const arrow = screen.getByLabelText(new RegExp(`^${graph.modules.find((m) => m.id === edge.from)!.name} to ${graph.modules.find((m) => m.id === edge.to)!.name}:`))
      const path = arrow.querySelector<SVGElement>('.react-flow__edge-path')!
      const stroke = path.style.stroke
      colors.add(stroke)
      const swatch = document.createElement('span')
      swatch.style.backgroundColor = stroke
      const dot = document.querySelector<HTMLElement>(`[data-id="${edge.from}"] .node-color`)!
      expect(swatch.style.backgroundColor).toBe(dot.style.backgroundColor)
      expect(path.style.strokeDasharray).toBe('')
    }
    expect(colors.size).toBeGreaterThan(2)
    await act(async () => {
      useStore.getState().dispatchOperation({ type: 'add_module', module: {
        id: 'notifications', name: 'Notifications', directory: null, description: '', responsibilities: [], publicInterface: []
      } })
      useStore.getState().dispatchOperation({ type: 'add_dependency', from: 'notifications', to: graph.modules[0].id, kind: 'depends_on' })
    })
    const declared = await screen.findByLabelText(`Notifications to ${graph.modules[0].name}: depends_on, declared`)
    expect(declared.querySelector<SVGElement>('.react-flow__edge-path')!.style.strokeDasharray).toBe('5 4')
    fireEvent.click(screen.getByRole('button', { name: 'Focus connections' }))
    await waitFor(() => {
      const unrelated = document.querySelector<SVGElement>('.react-flow__edge-path')!
      expect(unrelated.style.opacity).toBe('0.12')
      const connected = screen.getByLabelText(`Notifications to ${graph.modules[0].name}: depends_on, declared`)
      expect(connected.querySelector<SVGElement>('.react-flow__edge-path')!.style.opacity).toBe('1')
    })
    fireEvent.contextMenu(screen.getByLabelText(`Notifications to ${graph.modules[0].name}: depends_on, declared`), { clientX: 100, clientY: 100 })
    expect(screen.getByRole('menuitem', { name: 'Inspect source: Notifications' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove dependency' }))
    await waitFor(() => expect(screen.queryByLabelText(`Notifications to ${graph.modules[0].name}: depends_on, declared`)).toBeNull())
    expect(useStore.getState().operations.at(-1)?.type).toBe('remove_dependency')
  })

  it('creates a module at the right-clicked position and clears that position for toolbar creation', async () => {
    render(<App />)
    await openSample()
    fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, { clientX: 320, clientY: 180 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add module here…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a module' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Name/ }), { target: { value: 'Notifications' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add module' }))
    expect(useStore.getState().layout.positions.notifications).toEqual({ x: 320, y: 180 })
    expect(useStore.getState().operations).toHaveLength(1)
    expect(useStore.getState().operations[0].type).toBe('add_module')
    expect(useStore.getState().selectedModuleId).toBe('notifications')
    fireEvent.click(screen.getByRole('button', { name: 'Add Module' }))
    expect(useStore.getState().addModulePosition).toBeNull()
  })

  it('selects the right-clicked module and uses the existing delete dialog', async () => {
    render(<App />)
    await openSample()
    const auth = useStore.getState().desired!.modules.find((m) => m.name === 'Auth')!
    const node = document.querySelector(`[data-id="${auth.id}"] .module-node`)!
    fireEvent.contextMenu(node, { clientX: 400, clientY: 200 })
    expect(useStore.getState().selectedModuleId).toBe(auth.id)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show files' }))
    expect(useStore.getState().layout.expanded[auth.id]).toBe(true)
    expect(useStore.getState().operations).toHaveLength(0)
    fireEvent.contextMenu(node, { clientX: 400, clientY: 200 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete module…' }))
    expect(await screen.findByRole('dialog', { name: 'Delete “Auth”' })).toBeTruthy()
    expect(useStore.getState().desired!.modules.some((m) => m.id === auth.id)).toBe(true)
    expect(useStore.getState().operations).toHaveLength(0)
  })

  it('supports menu keyboard navigation, escape and outside-click dismissal', async () => {
    render(<App />)
    await openSample()
    const pane = document.querySelector('.react-flow__pane')!
    fireEvent.contextMenu(pane, { clientX: 9999, clientY: 9999 })
    const menu = await screen.findByRole('menu', { name: 'Canvas' })
    const first = within(menu).getByRole('menuitem', { name: 'Add module here…' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Fit graph to view' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Auto layout' }))
    expect(parseFloat(menu.style.left)).toBeLessThan(window.innerWidth)
    expect(parseFloat(menu.style.top)).toBeLessThan(window.innerHeight)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(pane)
    fireEvent.pointerDown(screen.getByText('Cartograph'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('dims unrelated modules in focus mode and restores them without changing the graph', async () => {
    render(<App />)
    await openSample()
    await act(async () => {
      useStore.getState().dispatchOperation({ type: 'add_module', module: {
        id: 'isolated', name: 'Isolated', directory: null, description: '', responsibilities: [], publicInterface: []
      } })
    })
    const before = useStore.getState().operations.length
    fireEvent.click(screen.getByRole('button', { name: 'Focus connections' }))
    await waitFor(() => {
      const dimmed = [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
        .filter((node) => node.style.opacity === '0.3')
      expect(dimmed.length).toBe(useStore.getState().desired!.modules.length - 1)
    })
    expect(document.querySelector<HTMLElement>('[data-id="isolated"]')!.style.opacity).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Focus connections · on' }))
    await waitFor(() => {
      expect([...document.querySelectorAll<HTMLElement>('.react-flow__node')].every((node) => node.style.opacity === '1')).toBe(true)
    })
    expect(useStore.getState().operations).toHaveLength(before)
  })
})

describe('making a structural change through the UI', () => {
  it('reviews edits in sequence and displays real before-and-after source after planning', async () => {
    render(<App />)
    await openSample()
    const auth = useStore.getState().desired!.modules.find((m) => m.name === 'Auth')!
    await act(async () => {
      useStore.getState().dispatchOperation({ type: 'add_module', module: {
        id: 'session', name: 'Session', description: 'Owns sessions', directory: 'src/session', responsibilities: [], publicInterface: []
      } })
      useStore.getState().dispatchOperation({ type: 'move_file', file: 'src/auth/session.ts', fromModuleId: auth.id, toModuleId: 'session' })
      useStore.getState().dispatchOperation({ type: 'rename_module', moduleId: 'session', name: 'Sessions', directory: 'src/sessions' })
    })
    fireEvent.click(screen.getByRole('button', { name: /02 Move file session.ts/ }))
    // Preview this operation at its place in the log, before the later directory rename.
    const before = screen.getByRole('region', { name: 'Architecture before' })
    const after = screen.getByRole('region', { name: 'Architecture after' })
    expect(before.textContent).toContain('src/auth/session.ts')
    expect(after.textContent).toContain('src/session/session.ts')
    expect(after.textContent).not.toContain('src/sessions/session.ts')
    expect(useStore.getState().selectedModuleId).toBe('session')
    expect(screen.queryByRole('region', { name: 'Source before' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /01 Create module Session/ }))
    expect(screen.getByRole('region', { name: 'Architecture before' }).textContent).toContain('Module does not exist')
    expect(screen.getByRole('region', { name: 'Architecture after' }).textContent).toContain('src/session')

    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }))
    await waitFor(() => expect(useStore.getState().changeSet).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /02 Move file session.ts/ }))
    const select = screen.getByRole('combobox', { name: 'Preview file' })
    const changes = useStore.getState().changeSet!.changes.filter((change) => change.operationIds.includes(useStore.getState().selectedOperationId!))
    expect(changes.length).toBeGreaterThan(0)
    const source = changes.find((change) => change.before !== null && change.after !== null)!
    fireEvent.change(select, { target: { value: source.path } })
    expect(screen.getByRole('region', { name: 'Source before' }).querySelector('pre')!.textContent).toBe(source.before)
    expect(screen.getByRole('region', { name: 'Source after' }).querySelector('pre')!.textContent).toBe(source.after)
    expect(useStore.getState().applyResult).toBeNull()
  }, 120_000)

  it('keeps module editing and file navigation accessible from the review desk', async () => {
    render(<App />)
    await openSample()
    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter modules' }), { target: { value: 'Auth' } })
    const modules = screen.getByText('Modules').closest('.pane-section')!
    fireEvent.click(within(modules as HTMLElement).getByRole('button', { name: /Auth/ }))
    expect(screen.getByDisplayValue('src/auth')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse review panel' }))
    expect(screen.queryByDisplayValue('src/auth')).toBeNull()
    const explorer = screen.getByText('Project explorer').closest('.pane-section')!
    fireEvent.click(within(explorer as HTMLElement).getByText('session.ts'))
    expect(useStore.getState().selectedFile).toBe('src/auth/session.ts')
    expect(screen.getByDisplayValue('src/auth')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '01 Architecture' }))
    expect(document.querySelector('.app.mode-architecture')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '02 Review changes' }))
    expect(screen.getByText('Every change deserves a closer look.')).toBeTruthy()
  })

  it('marks the affected modules as pending and plans real file changes', async () => {
    render(<App />)
    await openSample()

    const graph = useStore.getState().desired!
    const auth = graph.modules.find((m) => m.name === 'Auth')!

    // Create a module and move a file into it — the demo edit.
    await act(async () => {
      useStore.getState().dispatchOperation({
        type: 'add_module',
        module: {
          id: 'session-management',
          name: 'Session Management',
          description: 'Owns user sessions.',
          responsibilities: ['Create sessions'],
          directory: 'src/session-management',
          publicInterface: []
        }
      })
      useStore.getState().dispatchOperation({
        type: 'move_file',
        file: 'src/auth/session.ts',
        fromModuleId: auth.id,
        toModuleId: 'session-management'
      })
    })

    // The status bar now says the graph is ahead of the code.
    expect(
      await screen.findByText(/2 changes not yet in the code/i)
    ).toBeTruthy()

    // Both affected modules are flagged on the canvas.
    await waitFor(() => {
      const pendingNodes = [...document.querySelectorAll('.module-node.is-pending')]
      const names = pendingNodes.map(
        (el) => el.querySelector('.node-name')?.textContent
      )
      expect(names).toContain('Auth')
      expect(names).toContain('Session Management')
    })

    // Plan the changes, as the toolbar button does.
    await act(async () => {
      await useStore.getState().plan(false)
    })

    const changeSet = useStore.getState().changeSet!
    expect(changeSet.outcomes.every((o) => o.status === 'applied')).toBe(true)
    const paths = changeSet.changes.map((c) => c.path)
    expect(paths).toContain('src/session-management/index.ts')
    expect(paths).toContain('src/session-management/session.ts')
    expect(paths).toContain('src/auth/login.ts')

    // The Changes tab renders the plan with per-operation outcomes.
    await waitFor(() => {
      expect(screen.getByText(/file changes/)).toBeTruthy()
    })
    expect(screen.getAllByText('planned').length).toBe(2)
    expect(screen.getAllByText('Create module').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Move file').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Show diff').length).toBeGreaterThan(0)
  }, 120_000)

  it('writes the plan to a new directory and reports validation honestly', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-ui-'))
    scratch.push(dir)
    const outputDirectory = path.join(dir, 'generated')

    render(<App />)
    await openSample()

    const auth = useStore.getState().desired!.modules.find((m) => m.name === 'Auth')!
    await act(async () => {
      useStore.getState().dispatchOperation({
        type: 'add_module',
        module: {
          id: 'session-management',
          name: 'Session Management',
          description: 'Owns user sessions.',
          responsibilities: [],
          directory: 'src/session-management',
          publicInterface: []
        }
      })
      useStore.getState().dispatchOperation({
        type: 'move_file',
        file: 'src/auth/session.ts',
        fromModuleId: auth.id,
        toModuleId: 'session-management'
      })
      await useStore.getState().plan(false)
    })

    await act(async () => {
      await useStore.getState().apply({
        mode: 'new-directory',
        outputDirectory,
        createBackup: false,
        validate: true
      })
    })

    const result = useStore.getState().applyResult!
    expect(result.errors).toEqual([])
    expect(result.renamed).toEqual([
      { from: 'src/auth/session.ts', to: 'src/session-management/session.ts' }
    ])

    // The file really is where the graph says it is.
    const moved = await fs.readFile(
      path.join(outputDirectory, 'src/session-management/session.ts'),
      'utf8'
    )
    expect(moved).toContain('export function createSession')

    // The original project was not touched.
    await expect(
      fs.access(path.join(SAMPLE_PROJECT, 'src/auth/session.ts'))
    ).resolves.toBeUndefined()

    // The results tab reports the real outcome of the real checks.
    const validation = useStore.getState().validation!
    expect(validation.passed).toBe(true)
    await waitFor(() => {
      expect(screen.getByText('Generated into a new directory')).toBeTruthy()
    })
    expect(screen.getByText(/check\(s\) passed/)).toBeTruthy()
    expect(screen.getAllByText('passed').length).toBeGreaterThanOrEqual(2)

    // A second review cycle must open the new plan rather than the previous write's results.
    await act(async () => {
      useStore.getState().dispatchOperation({ type: 'update_module', moduleId: auth.id, description: 'Authentication boundary.' })
      await useStore.getState().plan(false)
    })
    fireEvent.click(screen.getByRole('button', { name: '03 Generate' }))
    expect(screen.getByText('No file changes')).toBeTruthy()
    expect(screen.getByText('graph only')).toBeTruthy()
  }, 180_000)

  it('reports an unsupported operation in the UI instead of claiming success', async () => {
    render(<App />)
    await openSample()

    const graph = useStore.getState().desired!
    const auth = graph.modules.find((m) => m.name === 'Auth')!
    const db = graph.modules.find((m) => m.name === 'Db')!

    await act(async () => {
      useStore.getState().dispatchOperation({
        type: 'remove_dependency',
        from: auth.id,
        to: db.id
      })
      await useStore.getState().plan(false)
    })

    const changeSet = useStore.getState().changeSet!
    expect(changeSet.changes).toEqual([])
    expect(changeSet.outcomes[0].status).toBe('unsupported')

    await waitFor(() => {
      expect(screen.getByText('No file changes')).toBeTruthy()
    })
    expect(screen.getByText('not supported')).toBeTruthy()
    expect(screen.getByText(/Potentially breaking:/)).toBeTruthy()
    expect(screen.getByText('no files changed')).toBeTruthy()
  }, 120_000)

  it('refuses an invalid edit and shows the reason', async () => {
    render(<App />)
    await openSample()

    const auth = useStore.getState().desired!.modules.find((m) => m.name === 'Auth')!
    await act(async () => {
      useStore.getState().dispatchOperation({
        type: 'add_dependency',
        from: auth.id,
        to: auth.id,
        kind: 'depends_on'
      })
    })

    expect(useStore.getState().operations).toEqual([])
    // Reported in the error banner and recorded in the activity log.
    await waitFor(() => {
      expect(
        screen.getAllByText('A module cannot depend on itself').length
      ).toBeGreaterThan(0)
    })
    expect(useStore.getState().error).toBe('A module cannot depend on itself')
  })
})

describe('reopening a saved architecture', () => {
  it('replays the saved edit log onto a fresh analysis', async () => {
    render(<App />)
    await openSample()

    const fresh = useStore.getState().original!
    const auth = fresh.modules.find((m) => m.name === 'Auth')!

    // A document as it would have been saved in an earlier session.
    const document = {
      schemaVersion: 1,
      projectRoot: fresh.projectRoot,
      original: fresh,
      desired: fresh,
      layout: useStore.getState().layout,
      operations: [
        {
          type: 'add_module' as const,
          module: {
            id: 'session-management',
            name: 'Session Management',
            description: 'Owns sessions.',
            responsibilities: [],
            directory: 'src/session-management',
            publicInterface: []
          },
          id: 'saved-1',
          actor: 'someone-else',
          issuedAt: '2026-01-01T00:00:00.000Z',
          baseVersion: 1
        },
        {
          type: 'move_file' as const,
          file: 'src/auth/session.ts',
          fromModuleId: auth.id,
          toModuleId: 'session-management',
          id: 'saved-2',
          actor: 'someone-else',
          issuedAt: '2026-01-01T00:00:01.000Z',
          baseVersion: 2
        },
        // An edit that no longer applies, because that module is long gone.
        {
          type: 'rename_module' as const,
          moduleId: 'deleted-ages-ago',
          name: 'Nope',
          id: 'saved-3',
          actor: 'someone-else',
          issuedAt: '2026-01-01T00:00:02.000Z',
          baseVersion: 3
        }
      ],
      appliedOperationIds: [],
      savedAt: '2026-01-01T00:00:03.000Z'
    }

    await act(async () => {
      useStore.getState().restoreDocument(document)
    })

    const state = useStore.getState()
    // The two applicable edits were replayed; the stale one was dropped and
    // reported rather than silently kept or silently discarded.
    expect(state.operations.map((o) => o.id)).toEqual(['saved-1', 'saved-2'])
    expect(
      state.desired!.modules.find((m) => m.name === 'Session Management')!.files
    ).toEqual(['src/session-management/session.ts'])
    // The freshly analyzed graph stays authoritative as the baseline.
    expect(state.original).toBe(fresh)
    expect(
      state.logs.some((l) => l.message.includes('no longer applies'))
    ).toBe(true)
    expect(
      state.logs.some((l) => l.message.includes('replayed 2 of 3'))
    ).toBe(true)
  }, 120_000)
})

describe('dialogs', () => {
  it('suggests an id and directory when adding a module', async () => {
    render(<App />)
    await openSample()

    await act(async () => {
      useStore.getState().openDialog('add-module')
    })

    const nameInput = await screen.findByPlaceholderText('Session Management')
    await act(async () => {
      // Typing through the DOM the way a user would.
      const input = nameInput as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )!.set!
      setter.call(input, 'Session Management')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(screen.getByText('session-management')).toBeTruthy()
    expect(screen.getByDisplayValue('src/session-management')).toBeTruthy()
  })

  it('explains the two write modes and gates overwriting behind a confirmation', async () => {
    render(<App />)
    await openSample()

    const auth = useStore.getState().desired!.modules.find((m) => m.name === 'Auth')!
    await act(async () => {
      useStore.getState().dispatchOperation({
        type: 'rename_module',
        moduleId: auth.id,
        name: 'Authentication',
        directory: 'src/authentication'
      })
      await useStore.getState().plan(false)
      useStore.getState().openDialog('generate')
    })

    expect(await screen.findByText('Generate into a new directory')).toBeTruthy()
    expect(screen.getByText('Overwrite the project')).toBeTruthy()
    expect(
      screen.getByText(/leaves the original untouched/i)
    ).toBeTruthy()

    // In-place writing needs an explicit acknowledgement.
    const overwrite = screen.getByText('Overwrite the project')
      .closest('label')!
      .querySelector('input')! as HTMLInputElement
    await act(async () => {
      overwrite.click()
    })
    expect(
      screen.getByText('I understand this modifies the project in place')
    ).toBeTruthy()
    const write = screen.getByRole('button', { name: 'Write changes' })
    expect(write.hasAttribute('disabled')).toBe(true)
  }, 120_000)
})
