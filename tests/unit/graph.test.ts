import { describe, expect, it } from 'vitest'

import {
  applyOperation,
  applyOperations,
  projectedMoveTarget,
  projectedPathAfterDirectoryRename
} from '../../src/shared/graph/apply-operation'
import { diffArchitectures, summarizeDiff } from '../../src/shared/graph/diff'
import { assignLayers, fillMissingPositions, layoutGraph } from '../../src/shared/graph/layout'
import {
  createEdge,
  createGraph,
  createModule,
  moduleOfFile,
  validateGraph
} from '../../src/shared/graph/model'
import { dependenciesOf, findCycles, searchGraph } from '../../src/shared/graph/selectors'
import { humanizeName, slugify, uniqueId } from '../../src/shared/util/id'
import type { ArchitectureGraph } from '../../src/shared/types/architecture'
import type { GraphOperation, GraphOperationBody } from '../../src/shared/types/operations'
import { isStructural, requiresAi } from '../../src/shared/types/operations'

let n = 0
function op(body: GraphOperationBody): GraphOperation {
  n += 1
  return {
    ...body,
    id: `op${n}`,
    actor: 'test',
    issuedAt: '2026-01-01T00:00:00.000Z',
    baseVersion: 1
  } as GraphOperation
}

/** A three-module graph: api -> auth -> db. */
function sampleGraph(): ArchitectureGraph {
  const graph = createGraph({
    projectRoot: '/tmp/project',
    name: 'demo',
    modules: [
      createModule({
        id: 'api',
        name: 'Api',
        directory: 'src/api',
        files: ['src/api/routes.ts'],
        origin: 'analysis'
      }),
      createModule({
        id: 'auth',
        name: 'Auth',
        directory: 'src/auth',
        files: ['src/auth/login.ts', 'src/auth/session.ts'],
        publicInterface: ['login', 'createSession'],
        responsibilities: ['Log users in', 'Create sessions'],
        origin: 'analysis'
      }),
      createModule({
        id: 'db',
        name: 'Db',
        directory: 'src/db',
        files: ['src/db/client.ts'],
        origin: 'analysis'
      })
    ],
    edges: [
      createEdge({ from: 'api', to: 'auth', verified: true, weight: 2 }),
      createEdge({ from: 'auth', to: 'db', verified: true, weight: 1 })
    ]
  })
  const auth = graph.modules.find((m) => m.id === 'auth')!
  auth.symbols = [
    {
      name: 'createSession',
      kind: 'function',
      file: 'src/auth/session.ts',
      line: 4,
      exported: true,
      isDefaultExport: false,
      signature: 'createSession(userId: string)',
      loc: 8
    },
    {
      name: 'login',
      kind: 'function',
      file: 'src/auth/login.ts',
      line: 9,
      exported: true,
      isDefaultExport: false,
      signature: 'login(email: string)',
      loc: 14
    }
  ]
  return graph
}

describe('identifier helpers', () => {
  it('slugifies names predictably', () => {
    expect(slugify('Session Management')).toBe('session-management')
    expect(slugify('userManagement')).toBe('user-management')
    expect(slugify('  ---  ')).toBe('module')
    expect(slugify('API v2!')).toBe('api-v2')
  })

  it('makes ids unique without clobbering the first', () => {
    const taken = new Set(['auth', 'auth-2'])
    expect(uniqueId('db', taken)).toBe('db')
    expect(uniqueId('auth', taken)).toBe('auth-3')
  })

  it('humanizes directory names', () => {
    expect(humanizeName('user-management')).toBe('User Management')
    expect(humanizeName('userManagement')).toBe('User Management')
    expect(humanizeName('api')).toBe('Api')
    expect(humanizeName('HTTP')).toBe('HTTP')
  })
})

describe('operation classification', () => {
  it('separates structural edits from documentation edits', () => {
    expect(isStructural({ type: 'move_file' })).toBe(true)
    expect(isStructural({ type: 'add_module' })).toBe(true)
    expect(isStructural({ type: 'update_module' })).toBe(false)
    expect(isStructural({ type: 'add_dependency' })).toBe(false)
  })

  it('knows which operations need a model', () => {
    expect(requiresAi({ type: 'move_responsibility' })).toBe(true)
    expect(requiresAi({ type: 'scaffold_module' })).toBe(true)
    expect(requiresAi({ type: 'move_file' })).toBe(false)
  })
})

describe('path projection', () => {
  it('rewrites paths under a renamed directory', () => {
    expect(
      projectedPathAfterDirectoryRename('src/auth/login.ts', 'src/auth', 'src/authn')
    ).toBe('src/authn/login.ts')
    expect(
      projectedPathAfterDirectoryRename('src/auth/deep/a.ts', 'src/auth', 'lib/a')
    ).toBe('lib/a/deep/a.ts')
    // Outside the renamed directory: untouched.
    expect(
      projectedPathAfterDirectoryRename('src/db/client.ts', 'src/auth', 'src/authn')
    ).toBe('src/db/client.ts')
  })

  it('places a moved file in the target directory, or leaves it put', () => {
    const withDir = createModule({ id: 'x', name: 'X', directory: 'src/x' })
    const withoutDir = createModule({ id: 'y', name: 'Y', directory: null })
    expect(projectedMoveTarget('src/auth/session.ts', withDir)).toBe('src/x/session.ts')
    expect(projectedMoveTarget('src/auth/session.ts', withoutDir)).toBe(
      'src/auth/session.ts'
    )
    expect(projectedMoveTarget('a/b.ts', withDir, 'custom/b.ts')).toBe('custom/b.ts')
  })
})

describe('the operation reducer', () => {
  it('adds a module and bumps the graph version', () => {
    const graph = sampleGraph()
    const result = applyOperation(graph, {
      type: 'add_module',
      module: {
        id: 'sessions',
        name: 'Sessions',
        description: 'Owns sessions',
        responsibilities: [],
        directory: 'src/sessions',
        publicInterface: ['createSession']
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.graph.modules).toHaveLength(4)
    expect(result.graph.version).toBe(graph.version + 1)
    // The input graph is untouched.
    expect(graph.modules).toHaveLength(3)
  })

  it('refuses a duplicate module id', () => {
    const result = applyOperation(sampleGraph(), {
      type: 'add_module',
      module: {
        id: 'auth',
        name: 'Clash',
        description: '',
        responsibilities: [],
        directory: null,
        publicInterface: []
      }
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/already exists/)
  })

  it('renames a module and relocates its files when the directory changes', () => {
    const result = applyOperation(sampleGraph(), {
      type: 'rename_module',
      moduleId: 'auth',
      name: 'Authentication',
      directory: 'src/authentication'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const auth = result.graph.modules.find((m) => m.id === 'auth')!
    expect(auth.name).toBe('Authentication')
    expect(auth.files).toEqual([
      'src/authentication/login.ts',
      'src/authentication/session.ts'
    ])
    // Symbol file references move with the files.
    expect(auth.symbols.every((s) => s.file.startsWith('src/authentication/'))).toBe(
      true
    )
  })

  it('renames a module without touching files when only the name changes', () => {
    const result = applyOperation(sampleGraph(), {
      type: 'rename_module',
      moduleId: 'auth',
      name: 'Authentication'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.graph.modules.find((m) => m.id === 'auth')!.files).toEqual([
      'src/auth/login.ts',
      'src/auth/session.ts'
    ])
  })

  it('moves a file, carrying its symbols and public interface entry', () => {
    const graph = sampleGraph()
    const added = applyOperation(graph, {
      type: 'add_module',
      module: {
        id: 'sessions',
        name: 'Sessions',
        description: '',
        responsibilities: [],
        directory: 'src/sessions',
        publicInterface: []
      }
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const moved = applyOperation(added.graph, {
      type: 'move_file',
      file: 'src/auth/session.ts',
      fromModuleId: 'auth',
      toModuleId: 'sessions'
    })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return

    const auth = moved.graph.modules.find((m) => m.id === 'auth')!
    const sessions = moved.graph.modules.find((m) => m.id === 'sessions')!
    expect(auth.files).toEqual(['src/auth/login.ts'])
    expect(sessions.files).toEqual(['src/sessions/session.ts'])
    expect(sessions.publicInterface).toContain('createSession')
    expect(auth.publicInterface).not.toContain('createSession')
    expect(sessions.symbols[0].file).toBe('src/sessions/session.ts')
    expect(moduleOfFile(moved.graph, 'src/sessions/session.ts')?.id).toBe('sessions')
    expect(validateGraph(moved.graph).filter((p) => p.severity === 'error')).toEqual([])
  })

  it('rejects moving a file that does not belong to the source module', () => {
    const result = applyOperation(sampleGraph(), {
      type: 'move_file',
      file: 'src/db/client.ts',
      fromModuleId: 'auth',
      toModuleId: 'db'
    })
    expect(result.ok).toBe(false)
  })

  it('warns when the target module has no directory', () => {
    const graph = sampleGraph()
    const added = applyOperation(graph, {
      type: 'add_module',
      module: {
        id: 'floating',
        name: 'Floating',
        description: '',
        responsibilities: [],
        directory: null,
        publicInterface: []
      }
    })
    if (!added.ok) throw new Error('setup failed')
    const moved = applyOperation(added.graph, {
      type: 'move_file',
      file: 'src/auth/session.ts',
      fromModuleId: 'auth',
      toModuleId: 'floating'
    })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.warnings.join(' ')).toMatch(/without moving on disk/)
  })

  it('deletes a module three different ways', () => {
    const orphan = applyOperation(sampleGraph(), {
      type: 'delete_module',
      moduleId: 'auth',
      fileDisposition: 'orphan'
    })
    expect(orphan.ok).toBe(true)
    if (!orphan.ok) return
    expect(orphan.graph.modules.map((m) => m.id)).toEqual(['api', 'db'])
    expect(orphan.graph.unassignedFiles).toEqual([
      'src/auth/login.ts',
      'src/auth/session.ts'
    ])
    // Edges touching the module go with it.
    expect(orphan.graph.edges).toEqual([])

    const reassigned = applyOperation(sampleGraph(), {
      type: 'delete_module',
      moduleId: 'auth',
      fileDisposition: 'reassign',
      reassignTo: 'db'
    })
    expect(reassigned.ok).toBe(true)
    if (!reassigned.ok) return
    const db = reassigned.graph.modules.find((m) => m.id === 'db')!
    expect(db.files).toEqual([
      'src/db/client.ts',
      'src/db/login.ts',
      'src/db/session.ts'
    ])
    expect(db.responsibilities).toContain('Create sessions')

    const deleted = applyOperation(sampleGraph(), {
      type: 'delete_module',
      moduleId: 'auth',
      fileDisposition: 'delete'
    })
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.warnings.join(' ')).toMatch(/will delete 2 source file/)

    const missingTarget = applyOperation(sampleGraph(), {
      type: 'delete_module',
      moduleId: 'auth',
      fileDisposition: 'reassign'
    })
    expect(missingTarget.ok).toBe(false)
  })

  it('records a declared dependency as unverified, and says so', () => {
    const result = applyOperation(sampleGraph(), {
      type: 'add_dependency',
      from: 'db',
      to: 'api',
      kind: 'depends_on'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const edge = result.graph.edges.find((e) => e.from === 'db' && e.to === 'api')!
    expect(edge.verified).toBe(false)
    expect(edge.origin).toBe('user')
    expect(result.warnings.join(' ')).toMatch(/intent, not evidence/)
  })

  it('warns when removing a dependency that real imports back', () => {
    const result = applyOperation(sampleGraph(), {
      type: 'remove_dependency',
      from: 'auth',
      to: 'db'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.join(' ')).toMatch(/requires real code changes/)
    expect(result.graph.edges).toHaveLength(1)
  })

  it('moves a responsibility between modules', () => {
    const result = applyOperation(sampleGraph(), {
      type: 'move_responsibility',
      responsibility: 'Create sessions',
      fromModuleId: 'auth',
      toModuleId: 'db'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.graph.modules.find((m) => m.id === 'auth')!.responsibilities
    ).toEqual(['Log users in'])
    expect(result.graph.modules.find((m) => m.id === 'db')!.responsibilities).toEqual(
      ['Create sessions']
    )
  })

  it('collects failures when folding a log of operations', () => {
    const result = applyOperations(sampleGraph(), [
      op({ type: 'rename_module', moduleId: 'auth', name: 'Authentication' }),
      op({ type: 'rename_module', moduleId: 'nope', name: 'Nothing' }),
      op({ type: 'update_module', moduleId: 'db', description: 'Data access' })
    ])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].operationId).toBe('op2')
    expect(result.graph.modules.find((m) => m.id === 'auth')!.name).toBe(
      'Authentication'
    )
    expect(result.graph.modules.find((m) => m.id === 'db')!.description).toBe(
      'Data access'
    )
  })
})

describe('the architecture diff', () => {
  it('reports nothing when the graphs match', () => {
    const graph = sampleGraph()
    const diff = diffArchitectures(graph, graph)
    expect(diff.empty).toBe(true)
    expect(summarizeDiff(diff)).toBe('No architectural changes')
  })

  it('describes added, renamed and moved, and survives a round trip', () => {
    const graph = sampleGraph()
    const result = applyOperations(graph, [
      op({
        type: 'add_module',
        module: {
          id: 'sessions',
          name: 'Sessions',
          description: 'Owns sessions',
          responsibilities: [],
          directory: 'src/sessions',
          publicInterface: []
        }
      }),
      op({
        type: 'move_file',
        file: 'src/auth/session.ts',
        fromModuleId: 'auth',
        toModuleId: 'sessions'
      }),
      op({ type: 'rename_module', moduleId: 'auth', name: 'Authentication' })
    ])

    const diff = diffArchitectures(graph, result.graph)
    expect(diff.addedModules).toEqual(['sessions'])
    expect(diff.renamedModules).toEqual([
      { id: 'auth', from: 'Auth', to: 'Authentication' }
    ])
    expect(diff.movedFiles).toEqual([
      { file: 'src/sessions/session.ts', from: 'auth', to: 'sessions' }
    ])
    expect(summarizeDiff(diff)).toMatch(/\+1 module/)

    // The move operation names the file by its original path, which is what the
    // engine needs to find it on disk.
    const moveOp = diff.operations.find((o) => o.type === 'move_file')
    expect(moveOp).toEqual({
      type: 'move_file',
      file: 'src/auth/session.ts',
      fromModuleId: 'auth',
      toModuleId: 'sessions'
    })

    // Replaying the derived operations reaches the same architecture.
    const replayed = applyOperations(
      graph,
      diff.operations.map((body) => op(body))
    )
    expect(replayed.failures).toEqual([])
    expect(replayed.graph.modules.map((m) => m.id).sort()).toEqual(
      result.graph.modules.map((m) => m.id).sort()
    )
    expect(
      replayed.graph.modules.find((m) => m.id === 'sessions')!.files
    ).toEqual(['src/sessions/session.ts'])
  })

  it('does not emit a file move for a pure directory rename', () => {
    const graph = sampleGraph()
    const renamed = applyOperation(graph, {
      type: 'rename_module',
      moduleId: 'auth',
      name: 'Auth',
      directory: 'src/authn'
    })
    if (!renamed.ok) throw new Error('setup failed')
    const diff = diffArchitectures(graph, renamed.graph)
    expect(diff.movedFiles).toEqual([])
    expect(diff.renamedModules).toHaveLength(1)
  })

  it('treats a deleted module as one operation, not a cascade', () => {
    const graph = sampleGraph()
    const deleted = applyOperation(graph, {
      type: 'delete_module',
      moduleId: 'auth',
      fileDisposition: 'orphan'
    })
    if (!deleted.ok) throw new Error('setup failed')
    const diff = diffArchitectures(graph, deleted.graph)
    expect(diff.removedModules).toEqual(['auth'])
    expect(diff.removedDependencies).toEqual([])
    expect(diff.operations.filter((o) => o.type === 'remove_dependency')).toEqual([])
  })
})

describe('layout', () => {
  it('layers modules so dependencies sit to the right of their dependents', () => {
    const graph = sampleGraph()
    const layers = assignLayers(graph)
    expect(layers.get('api')).toBe(0)
    expect(layers.get('auth')).toBe(1)
    expect(layers.get('db')).toBe(2)

    const positions = layoutGraph(graph)
    expect(positions.api.x).toBeLessThan(positions.auth.x)
    expect(positions.auth.x).toBeLessThan(positions.db.x)
    expect(Object.keys(positions).sort()).toEqual(['api', 'auth', 'db'])
  })

  it('is deterministic and survives a cycle', () => {
    const graph = sampleGraph()
    graph.edges.push(createEdge({ from: 'db', to: 'api', verified: true }))
    const first = layoutGraph(graph)
    const second = layoutGraph(graph)
    expect(first).toEqual(second)
    expect(Object.keys(first)).toHaveLength(3)
    expect(findCycles(graph).length).toBeGreaterThan(0)
  })

  it('only fills in positions that are missing', () => {
    const graph = sampleGraph()
    const existing = { api: { x: 10, y: 20 } }
    const filled = fillMissingPositions(graph, existing)
    expect(filled.api).toEqual({ x: 10, y: 20 })
    expect(filled.auth).toBeDefined()
    expect(filled.db).toBeDefined()
  })
})

describe('selectors', () => {
  it('finds dependencies and searches the graph', () => {
    const graph = sampleGraph()
    expect(dependenciesOf(graph, 'api').map((d) => d.module.id)).toEqual(['auth'])

    const hits = searchGraph(graph, 'session')
    expect(hits.some((h) => h.kind === 'file' && h.label === 'src/auth/session.ts')).toBe(
      true
    )
    expect(hits.some((h) => h.kind === 'symbol' && h.label === 'createSession')).toBe(
      true
    )
    expect(searchGraph(graph, '')).toEqual([])
  })

  it('detects a graph that claims the same file twice', () => {
    const graph = sampleGraph()
    graph.modules.find((m) => m.id === 'db')!.files.push('src/auth/login.ts')
    const problems = validateGraph(graph)
    expect(problems.some((p) => p.message.includes('claimed by both'))).toBe(true)
  })
})
