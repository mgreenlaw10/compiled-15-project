/**
 * The AI layer, tested without a network call or an API key.
 *
 * Two things matter here and both are testable offline: the tools the model is
 * given (what they let it reach, and what they refuse), and the check that
 * decides whether to believe what the model says it did.
 */

import { describe, expect, it } from 'vitest'

import { runAgent, type AgentOutcome, type RunAgentOptions } from '../../src/core/ai/agent'
import { createAiTransformer } from '../../src/core/ai/transformer'
import {
  createToolRunState,
  runTool,
  toolDefinitions,
  type ToolRunContext
} from '../../src/core/ai/tools'
import { silentLogger } from '../../src/core/logger'
import { planChanges } from '../../src/core/transform/engine'
import type { OpContext } from '../../src/core/transform/ops/context'
import { VirtualWorkspace } from '../../src/core/transform/workspace'
import { createEdge, createGraph, createModule } from '../../src/shared/graph/model'
import type { ArchitectureGraph } from '../../src/shared/types/architecture'
import type { GraphOperation, GraphOperationBody } from '../../src/shared/types/operations'

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

function fixture(): {
  graph: ArchitectureGraph
  workspace: VirtualWorkspace
  ctx: ToolRunContext
} {
  const graph = createGraph({
    projectRoot: '/p',
    name: 'tiny',
    modules: [
      createModule({
        id: 'auth',
        name: 'Auth',
        description: 'Signs users in.',
        responsibilities: ['Log users in'],
        directory: 'src/auth',
        files: ['src/auth/login.ts', 'src/auth/session.ts'],
        publicInterface: ['login', 'createSession'],
        origin: 'analysis'
      }),
      createModule({
        id: 'db',
        name: 'Db',
        description: 'Data access.',
        directory: 'src/db',
        files: ['src/db/client.ts'],
        publicInterface: ['db'],
        origin: 'analysis'
      }),
      createModule({
        id: 'sessions',
        name: 'Sessions',
        description: 'Owns sessions.',
        directory: 'src/sessions',
        files: [],
        origin: 'user'
      })
    ],
    edges: [createEdge({ from: 'auth', to: 'db', verified: true, weight: 2 })]
  })

  const auth = graph.modules.find((m) => m.id === 'auth')!
  auth.symbols = [
    {
      name: 'createSession',
      kind: 'function',
      file: 'src/auth/session.ts',
      line: 3,
      exported: true,
      isDefaultExport: false,
      signature: 'createSession(userId: string)',
      loc: 4
    }
  ]
  graph.edges[0].evidence = [
    {
      fromFile: 'src/auth/session.ts',
      toFile: 'src/db/client.ts',
      specifier: '../db/client',
      symbols: ['db'],
      line: 1
    }
  ]

  const workspace = new VirtualWorkspace('/p', [
    [
      'src/auth/login.ts',
      [
        "import { createSession } from './session'",
        'export function login(id: string) {',
        '  return createSession(id)',
        '}',
        ''
      ].join('\n')
    ],
    [
      'src/auth/session.ts',
      [
        "import { db } from '../db/client'",
        '/** Creates a session. */',
        'export function createSession(userId: string) {',
        '  return { userId, db }',
        '}',
        ''
      ].join('\n')
    ],
    ['src/db/client.ts', 'export const db = {}\n']
  ])

  return {
    graph,
    workspace,
    ctx: {
      workspace,
      graph,
      nextGraph: graph,
      operation: op({ type: 'scaffold_module', moduleId: 'sessions', instructions: '' }),
      log: silentLogger.child('ai'),
      maxFileReads: 3
    }
  }
}

describe('tool definitions', () => {
  it('describes a closed set of tools with strict schemas', () => {
    const tools = toolDefinitions()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'delete_file',
      'find_symbol',
      'list_files',
      'move_file_to_module',
      'move_symbol_to_file',
      'query_graph',
      'read_file',
      'report_result',
      'write_file'
    ])

    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
      // Large inputs (whole file contents) stream as they are generated.
      expect(tool.eager_input_streaming).toBe(true)
      const schema = tool.input_schema as Record<string, unknown>
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(schema).not.toHaveProperty('$schema')
    }
  })
})

describe('tool execution', () => {
  it('answers questions about the graph', async () => {
    const { ctx } = fixture()
    const state = createToolRunState()

    const modules = await runTool('query_graph', { what: 'modules' }, ctx, state)
    expect(modules.isError).toBe(false)
    expect(modules.content).toContain('auth — "Auth"')
    expect(modules.content).toContain('sessions — "Sessions"')

    const one = await runTool(
      'query_graph',
      { what: 'module', moduleId: 'auth' },
      ctx,
      state
    )
    expect(one.content).toContain('src/auth/session.ts')
    expect(one.content).toContain('export function createSession')

    const deps = await runTool(
      'query_graph',
      { what: 'dependencies', moduleId: 'auth' },
      ctx,
      state
    )
    expect(deps.content).toContain('verified by static analysis')

    // The evidence behind an edge, with file and line.
    const evidence = await runTool(
      'query_graph',
      { what: 'edge_evidence', moduleId: 'auth', otherModuleId: 'db' },
      ctx,
      state
    )
    expect(evidence.content).toContain('src/auth/session.ts:1 imports db')

    const missing = await runTool('query_graph', { what: 'module' }, ctx, state)
    expect(missing.isError).toBe(true)
  })

  it('lists and reads files, and enforces the read budget', async () => {
    const { ctx } = fixture()
    const state = createToolRunState()

    const listed = await runTool('list_files', { moduleId: 'auth' }, ctx, state)
    expect(listed.content.split('\n').sort()).toEqual([
      'src/auth/login.ts',
      'src/auth/session.ts'
    ])

    const read = await runTool('read_file', { path: 'src/auth/session.ts' }, ctx, state)
    expect(read.isError).toBe(false)
    expect(read.content).toContain('export function createSession')
    expect(state.fileReads).toBe(1)

    const ranged = await runTool(
      'read_file',
      { path: 'src/auth/session.ts', startLine: 1, endLine: 1 },
      ctx,
      state
    )
    expect(ranged.content).toContain("import { db }")
    expect(ranged.content).not.toContain('createSession')

    const absent = await runTool('read_file', { path: 'src/nope.ts' }, ctx, state)
    expect(absent.isError).toBe(true)
    expect(absent.content).toContain('not one of this project')

    // maxFileReads is 3 in the fixture.
    await runTool('read_file', { path: 'src/db/client.ts' }, ctx, state)
    const overBudget = await runTool(
      'read_file',
      { path: 'src/auth/login.ts' },
      ctx,
      state
    )
    expect(overBudget.isError).toBe(true)
    expect(overBudget.content).toContain('limit of 3 file reads')
  })

  it('refuses paths that leave the project', async () => {
    const { ctx, workspace } = fixture()
    const state = createToolRunState()

    for (const path of ['/etc/passwd', '../../outside.ts', 'node_modules/x/i.js']) {
      const result = await runTool('write_file', { path, contents: 'x', reason: 'r' }, ctx, state)
      expect(result.isError).toBe(true)
    }
    expect(workspace.clean).toBe(true)
  })

  it('writes into the workspace, never to disk', async () => {
    const { ctx, workspace } = fixture()
    const state = createToolRunState()

    const written = await runTool(
      'write_file',
      {
        path: 'src/sessions/index.ts',
        contents: 'export const marker = 1\n',
        reason: 'create the module entry'
      },
      ctx,
      state
    )
    expect(written.isError).toBe(false)
    expect(written.content).toContain('Nothing has been written to disk')
    expect(workspace.read('src/sessions/index.ts')).toBe('export const marker = 1\n')
    expect(state.touchedPaths.has('src/sessions/index.ts')).toBe(true)

    const change = workspace.changes().find((c) => c.path === 'src/sessions/index.ts')!
    expect(change.kind).toBe('create')
    expect(change.reason).toContain('AI: create the module entry')
    expect(change.operationIds).toEqual([ctx.operation.id])
  })

  it('deletes a file and reports a missing one', async () => {
    const { ctx, workspace } = fixture()
    const state = createToolRunState()

    const deleted = await runTool(
      'delete_file',
      { path: 'src/db/client.ts', reason: 'no longer needed' },
      ctx,
      state
    )
    expect(deleted.isError).toBe(false)
    expect(workspace.exists('src/db/client.ts')).toBe(false)

    const again = await runTool(
      'delete_file',
      { path: 'src/db/client.ts', reason: 'again' },
      ctx,
      state
    )
    expect(again.isError).toBe(true)
  })

  it('exposes the compiler-aware refactors as tools', async () => {
    const { ctx, workspace } = fixture()
    const state = createToolRunState()

    const moved = await runTool(
      'move_file_to_module',
      { file: 'src/auth/session.ts', toModuleId: 'sessions' },
      ctx,
      state
    )
    expect(moved.isError).toBe(false)
    expect(moved.content).toContain('rewrote')
    // The import in the file that used it was fixed for us.
    expect(workspace.read('src/auth/login.ts')).toContain(
      "from '../sessions/session'"
    )
    expect(workspace.exists('src/sessions/session.ts')).toBe(true)
  })

  it('moves a symbol through the deterministic engine', async () => {
    const { ctx, workspace } = fixture()
    const state = createToolRunState()

    const result = await runTool(
      'move_symbol_to_file',
      {
        symbol: 'createSession',
        fromFile: 'src/auth/session.ts',
        toModuleId: 'sessions',
        toFile: 'src/sessions/create.ts',
        leaveReExport: false
      },
      ctx,
      state
    )
    expect(result.isError).toBe(false)

    const created = workspace.read('src/sessions/create.ts')!
    expect(created).toContain('export function createSession')
    expect(created).toContain('Creates a session.')
    // Its dependency came along, with the specifier recomputed.
    expect(created).toContain("from '../db/client'")
    // And the importer now points at the new home.
    expect(workspace.read('src/auth/login.ts')).toContain(
      "from '../sessions/create'"
    )
    expect(workspace.read('src/auth/session.ts')).not.toContain('createSession')
  })

  it('rejects an unknown tool and a malformed input', async () => {
    const { ctx } = fixture()
    const state = createToolRunState()

    const unknown = await runTool('rm_rf', {}, ctx, state)
    expect(unknown.isError).toBe(true)
    expect(unknown.content).toContain('no tool called')

    const bad = await runTool('read_file', { wrong: true }, ctx, state)
    expect(bad.isError).toBe(true)
    expect(bad.content).toContain('did not match the schema')

    const badEnum = await runTool('query_graph', { what: 'everything' }, ctx, state)
    expect(badEnum.isError).toBe(true)
  })

  it('records the final report', async () => {
    const { ctx } = fixture()
    const state = createToolRunState()
    await runTool(
      'report_result',
      { status: 'partial', summary: 'Moved one of two.', warnings: ['check x'] },
      ctx,
      state
    )
    expect(state.finalReport).toEqual({
      status: 'partial',
      summary: 'Moved one of two.',
      warnings: ['check x']
    })
  })
})

describe('the AI transformer', () => {
  const graph = createGraph({
    projectRoot: '/p',
    name: 'tiny',
    modules: [
      createModule({ id: 'a', name: 'A', directory: 'src/a', files: ['src/a/x.ts'] }),
      createModule({ id: 'b', name: 'B', directory: 'src/b', files: [] })
    ]
  })

  function context(workspace: VirtualWorkspace): OpContext {
    return { workspace, graph, nextGraph: graph, log: silentLogger.child('ai') }
  }

  function outcome(partial: Partial<AgentOutcome>): AgentOutcome {
    return {
      report: null,
      touchedPaths: [],
      turns: 1,
      stoppedBecause: null,
      usage: { inputTokens: 10, outputTokens: 20 },
      ...partial
    }
  }

  const config = {
    provider: 'anthropic',
    apiKey: 'test-key',
    model: 'claude-opus-5-5',
    effort: 'high' as const,
    maxFileReads: 10
  }

  const moveResponsibility = op({
    type: 'move_responsibility',
    responsibility: 'Do the thing',
    fromModuleId: 'a',
    toModuleId: 'b'
  })

  it('is unavailable without a key, and says why', async () => {
    const transformer = createAiTransformer({ config: null, logger: silentLogger })
    expect(transformer.available).toBe(false)
    expect(transformer.unavailableReason).toContain('API key')

    const result = await transformer.execute(
      moveResponsibility,
      context(new VirtualWorkspace('/p', []))
    )
    expect(result.status).toBe('unsupported')
    expect(result.executor).toBe('none')
  })

  it('believes a success that changed files', async () => {
    const workspace = new VirtualWorkspace('/p', [['src/a/x.ts', 'export const x = 1\n']])
    const transformer = createAiTransformer({
      config,
      logger: silentLogger,
      runner: async () =>
        outcome({
          report: { status: 'applied', summary: 'Moved the code.', warnings: [] },
          touchedPaths: ['src/b/x.ts']
        })
    })

    const result = await transformer.execute(moveResponsibility, context(workspace))
    expect(result.status).toBe('applied')
    expect(result.executor).toBe('ai')
    expect(result.message).toContain('Moved the code.')
    expect(result.touchedPaths).toEqual(['src/b/x.ts'])
  })

  it('downgrades a success that changed nothing', async () => {
    const transformer = createAiTransformer({
      config,
      logger: silentLogger,
      runner: async () =>
        outcome({
          report: { status: 'applied', summary: 'All done!', warnings: [] },
          touchedPaths: []
        })
    })

    const result = await transformer.execute(
      moveResponsibility,
      context(new VirtualWorkspace('/p', []))
    )
    // This is the guarantee that matters: a claim with no change set behind it
    // is not reported to the user as applied.
    expect(result.status).toBe('unsupported')
    expect(result.message).toContain('changed no files')
    expect(result.warnings.join(' ')).toContain('did not match the change set')
  })

  it('upgrades a refusal that changed files to partial', async () => {
    const transformer = createAiTransformer({
      config,
      logger: silentLogger,
      runner: async () =>
        outcome({
          report: {
            status: 'unsupported',
            summary: 'Could not finish.',
            warnings: []
          },
          touchedPaths: ['src/b/x.ts']
        })
    })

    const result = await transformer.execute(
      moveResponsibility,
      context(new VirtualWorkspace('/p', []))
    )
    expect(result.status).toBe('partial')
    expect(result.warnings.join(' ')).toContain('did not consider the task complete')
  })

  it('reports a missing report as failed, or partial when files changed', async () => {
    const silent = createAiTransformer({
      config,
      logger: silentLogger,
      runner: async () => outcome({ stoppedBecause: 'Ran out of turns.' })
    })
    const nothing = await silent.execute(
      moveResponsibility,
      context(new VirtualWorkspace('/p', []))
    )
    expect(nothing.status).toBe('failed')
    expect(nothing.message).toBe('Ran out of turns.')

    const half = createAiTransformer({
      config,
      logger: silentLogger,
      runner: async () =>
        outcome({ stoppedBecause: 'Canceled.', touchedPaths: ['src/b/x.ts'] })
    })
    const partial = await half.execute(
      moveResponsibility,
      context(new VirtualWorkspace('/p', []))
    )
    expect(partial.status).toBe('partial')
    expect(partial.warnings.join(' ')).toContain('Review them closely')
  })

  it('refuses operations it is not meant to handle', async () => {
    const transformer = createAiTransformer({
      config,
      logger: silentLogger,
      runner: async () => outcome({})
    })
    const result = await transformer.execute(
      op({ type: 'update_module', moduleId: 'a', description: 'x' }),
      context(new VirtualWorkspace('/p', []))
    )
    expect(result.status).toBe('unsupported')
    expect(result.message).toContain('does not handle')
  })
})

describe('the engine routes AI-only operations to the transformer', () => {
  const graph = createGraph({
    projectRoot: '/p',
    name: 'tiny',
    modules: [
      createModule({ id: 'a', name: 'A', directory: 'src/a', files: ['src/a/x.ts'] }),
      createModule({ id: 'b', name: 'B', directory: 'src/b', files: [] })
    ]
  })
  const files: [string, string][] = [['src/a/x.ts', 'export const x = 1\n']]

  it('hands move_responsibility to the AI transformer and keeps its outcome', async () => {
    let seen: string | null = null
    const { changeSet } = await planChanges(
      graph,
      [
        op({
          type: 'move_responsibility',
          responsibility: 'Own x',
          fromModuleId: 'a',
          toModuleId: 'b'
        })
      ],
      files,
      {
        ai: {
          available: true,
          unavailableReason: '',
          async execute(operation, ctx) {
            seen = operation.type
            ctx.workspace.write('src/b/x.ts', 'export const x = 1\n', {
              reason: 'AI moved it',
              operationId: operation.id
            })
            return {
              status: 'applied',
              executor: 'ai',
              message: 'Moved x into B.',
              touchedPaths: ['src/b/x.ts'],
              warnings: ['Double-check the import in src/a']
            }
          }
        }
      }
    )

    expect(seen).toBe('move_responsibility')
    expect(changeSet.outcomes[0]).toMatchObject({
      status: 'applied',
      executor: 'ai',
      message: 'Moved x into B.'
    })
    expect(changeSet.outcomes[0].warnings).toEqual([
      'Double-check the import in src/a'
    ])
    expect(changeSet.changes.map((c) => c.path)).toEqual(['src/b/x.ts'])
    expect(changeSet.aiSkipped).toBe(false)
  })

  it('reports it as unsupported, and flags aiSkipped, when no model is available', async () => {
    const { changeSet } = await planChanges(
      graph,
      [op({ type: 'scaffold_module', moduleId: 'b', instructions: 'write it' })],
      files,
      {
        ai: {
          available: false,
          unavailableReason: 'No key configured for this test.',
          async execute() {
            throw new Error('must not be called')
          }
        }
      }
    )

    expect(changeSet.outcomes[0].status).toBe('unsupported')
    expect(changeSet.outcomes[0].message).toContain('No key configured for this test.')
    expect(changeSet.aiSkipped).toBe(true)
    expect(changeSet.changes).toEqual([])
  })

  it('turns a throwing transformer into a failed outcome, not a crash', async () => {
    const { changeSet } = await planChanges(
      graph,
      [op({ type: 'scaffold_module', moduleId: 'b', instructions: '' })],
      files,
      {
        ai: {
          available: true,
          unavailableReason: '',
          async execute() {
            throw new Error('the API exploded')
          }
        }
      }
    )
    expect(changeSet.outcomes[0].status).toBe('failed')
    expect(changeSet.outcomes[0].message).toContain('the API exploded')
  })
})

describe('the agent loop', () => {
  it('is exported with the shape the transformer expects', () => {
    // A guard against the runner signature drifting away from its injection
    // point; the loop itself is exercised against the live API, not here.
    const runner: (options: RunAgentOptions) => Promise<AgentOutcome> = runAgent
    expect(typeof runner).toBe('function')
  })
})
