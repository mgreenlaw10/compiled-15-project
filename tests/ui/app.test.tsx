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
    dialog: null,
    busy: 'idle',
    error: null,
    notice: null,
    dirty: false,
    logs: [],
    bottomTab: 'activity',
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
  it('writes source immediately when Generate Project is clicked and retains the results', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-generate-click-'))
    scratch.push(root)
    await fs.cp(SAMPLE_PROJECT, root, { recursive: true, filter: (file) => !file.includes('node_modules') && !file.includes('.cartograph') })
    const fake = installFakeApi({ projectToOpen: root })
    render(<App />)
    await openSample()
    act(() => useStore.getState().dispatchOperation({ type: 'add_module', module: {
      id: 'immediate', name: 'Immediate', description: 'A generated module', responsibilities: [],
      directory: 'src/immediate', publicInterface: []
    } }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate Project' }))
      await waitFor(() => expect(useStore.getState().applyResult).not.toBeNull(), { timeout: 30000 })
      await waitFor(() => expect(useStore.getState().busy).toBe('idle'), { timeout: 30000 })
    })
    expect(await fs.readFile(path.join(root, 'src/immediate/index.ts'), 'utf8')).toContain('Immediate')
    const write = fake.calls.find((call) => call.method === 'applyChanges')!
    expect(write.args[0]).toBe(root)
    expect(write.args[1]).toMatchObject({ mode: 'in-place', createBackup: true, validate: true })
    expect(useStore.getState().dialog).toBeNull()
    expect(useStore.getState().bottomTab).toBe('results')
    expect(useStore.getState().operations).toEqual([])
    expect(useStore.getState().original!.modules.some((m) => m.files.includes('src/immediate/index.ts'))).toBe(true)
  }, 60000)
  it('resizes the inspector, retains width across selections, and records no architectural edit', async () => {
    const rendered = render(<App />)
    await openSample()
    const graph = useStore.getState().desired
    const handle = screen.getByRole('separator', { name: 'Resize inspector' })
    const overlay = rendered.container.querySelector('.inspector-overlay') as HTMLElement
    const workspace = rendered.container.querySelector('.workspace') as HTMLElement
    const previousStyle = workspace.getAttribute('style')
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 700 }))
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 500 }))
    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true, clientX: 500 }))
    expect(overlay.style.getPropertyValue('--inspector-width')).toBe('540px')
    const symbol = graph!.program.symbols.find((s) => s.kind === 'function')!
    act(() => useStore.getState().selectSymbol(symbol.id))
    expect(screen.getByLabelText('Symbol name')).toBeTruthy()
    expect(overlay.style.getPropertyValue('--inspector-width')).toBe('540px')
    expect(workspace.getAttribute('style')).toBe(previousStyle)
    expect(useStore.getState().desired).toBe(graph)
    expect(useStore.getState().operations).toEqual([])
    expect(useStore.getState().dirty).toBe(false)
    fireEvent.keyDown(handle, { key: 'End' })
    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(Number(handle.getAttribute('aria-valuemax')))
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(Number(handle.getAttribute('aria-valuemax')))
    fireEvent.doubleClick(handle)
    expect(overlay.style.getPropertyValue('--inspector-width')).toBe('340px')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(overlay.style.getPropertyValue('--inspector-width')).toBe('340px')
  })

  it('starts with no project and explains what to do', async () => {
    render(<App />)

    expect(screen.getByText('Cartograph')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Project' })).toBeTruthy()
    // Both the status bar and the canvas say so.
    expect(screen.getAllByText(/No project open/i).length).toBeGreaterThan(1)
    expect(screen.getByText(/Open a project to begin/i)).toBeTruthy()

    // Nothing to generate yet, so the action is disabled rather than lying.
    const generate = screen.getByRole('button', { name: 'Generate Project' })
    expect(generate.hasAttribute('disabled')).toBe(true)

    // No key configured: the toolbar says so, and the app still works.
    expect(screen.getByText('no api key')).toBeTruthy()
    await waitFor(() => expect(useStore.getState().settings).not.toBeNull())
  })

  it('shows the analyzed module graph and the file-to-module mapping', async () => {
    render(<App />)
    await openSample()

    // The project pane reports what is open: name and path, nothing else.
    expect(await screen.findByText('shop-api')).toBeTruthy()
    expect(screen.getAllByText(/sample-project/).length).toBeGreaterThan(0)

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
    expect(screen.getByText('src/auth/session.ts', { selector: '.row-title' })).toBeTruthy()
    // Listed both as part of the public interface and as a declaration.
    expect(screen.getAllByText('createSession').length).toBeGreaterThan(1)

    // The inspector no longer explains the two kinds of edit inline, so the
    // status bar is the only thing left that distinguishes a documentation
    // edit from one that will change code. It has to keep doing so.
    const moduleId = useStore.getState().selectedModuleId!

    act(() => {
      useStore.getState().dispatchOperation({
        type: 'update_module',
        moduleId,
        description: 'Documentation only.'
      })
    })
    expect(screen.getByText(/documentation edit/i)).toBeTruthy()

    act(() => {
      useStore.getState().dispatchOperation({
        type: 'rename_module',
        moduleId,
        name: 'Authentication',
        directory: 'src/authentication'
      })
    })
    expect(screen.getByText(/not yet in the code/i)).toBeTruthy()
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

describe('making a structural change through the UI', () => {
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
    expect(screen.getAllByText('applied').length).toBe(2)
    expect(screen.getByText('Create module')).toBeTruthy()
    expect(screen.getByText('Move file')).toBeTruthy()
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
    expect(useStore.getState().appliedOperationIds).toEqual([])
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
    await act(async () => { await useStore.getState().plan(false) })
    expect(useStore.getState().changeSet!.outcomes.some((o) => o.status === 'failed')).toBe(false)
    expect(useStore.getState().changeSet!.changes.some((c) => c.kind === 'rename')).toBe(true)
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
