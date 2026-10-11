/**
 * The end-to-end proof.
 *
 * Each test here walks the whole pipeline the way a user does — import a real
 * codebase, build the graph, make a structural edit, generate the code, verify
 * the output — against a throwaway copy of the sample project, and then checks
 * that the generated project still type checks and that its own tests pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { analyzeProject } from '../../src/core/analyzer'
import { suggestDirectoryForNewModule } from '../../src/core/analyzer/cluster'
import { createService, loadSourceFiles } from '../../src/core/pipeline'
import { planChanges, summarizeOutcomes } from '../../src/core/transform/engine'
import { restoreBackup } from '../../src/core/output/writer'
import { applyOperation, applyOperations } from '../../src/shared/graph/apply-operation'
import { diffArchitectures } from '../../src/shared/graph/diff'
import { validateGraph } from '../../src/shared/graph/model'
import { createCollectingLogger } from '../../src/core/logger'
import type { ArchitectureGraph } from '../../src/shared/types/architecture'
import type { GraphOperation, GraphOperationBody } from '../../src/shared/types/operations'

const SAMPLE = path.resolve(__dirname, '../../sample-project')
const scratchDirs: string[] = []

/** A fresh copy of the sample project, so tests never touch the original. */
async function copySample(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cartograph-${label}-`))
  const target = path.join(dir, 'shop-api')
  await fs.cp(SAMPLE, target, { recursive: true })
  scratchDirs.push(dir)
  return target
}

let opCounter = 0
function op(body: GraphOperationBody, baseVersion = 1): GraphOperation {
  opCounter += 1
  return {
    ...body,
    id: `test_op_${opCounter}`,
    actor: 'test',
    issuedAt: '2026-01-01T00:00:00.000Z',
    baseVersion
  } as GraphOperation
}

function moduleNamed(graph: ArchitectureGraph, name: string) {
  const found = graph.modules.find((m) => m.name === name)
  if (!found) {
    throw new Error(
      `No module named ${name}; have: ${graph.modules.map((m) => m.name).join(', ')}`
    )
  }
  return found
}

afterAll(async () => {
  for (const dir of scratchDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('import → analyze → edit → generate → verify', () => {
  let root: string
  let graph: ArchitectureGraph

  beforeAll(async () => {
    root = await copySample('e2e')
    const analyzed = await analyzeProject(root)
    graph = analyzed.graph
  })

  it('extracts a new Session Management module out of Auth, and the result compiles', async () => {
    const { logger, events } = createCollectingLogger()
    const auth = moduleNamed(graph, 'Auth')
    const directory = suggestDirectoryForNewModule(
      graph.modules.map((m) => m.directory),
      'Session Management'
    )
    expect(directory).toBe('src/session-management')

    // The exact edits a user makes in the graph editor: create the module,
    // then move the session file into it.
    const operations = [
      op({
        type: 'add_module',
        module: {
          id: 'session-management',
          name: 'Session Management',
          description: 'Owns user sessions and their lifecycle.',
          responsibilities: ['Create sessions', 'Expire and revoke sessions'],
          directory,
          publicInterface: []
        }
      }),
      op({
        type: 'move_file',
        file: 'src/auth/session.ts',
        fromModuleId: auth.id,
        toModuleId: 'session-management'
      })
    ]

    const files = await loadSourceFiles(root)
    const { changeSet, graph: desired } = await planChanges(
      graph,
      operations,
      files,
      { logger }
    )

    // ---- The plan says what it did, per operation ----------------------
    const counts = summarizeOutcomes(changeSet)
    expect(counts.failed).toBe(0)
    expect(counts.unsupported).toBe(0)
    expect(counts.applied).toBe(2)

    // ---- The new module's file is created ------------------------------
    const created = changeSet.changes.filter((c) => c.kind === 'create')
    expect(created.map((c) => c.path)).toEqual(['src/session-management/index.ts'])

    // ---- The session file moved, carrying its content ------------------
    const moved = changeSet.changes.find((c) => c.kind === 'rename')
    expect(moved).toBeDefined()
    expect(moved!.previousPath).toBe('src/auth/session.ts')
    expect(moved!.path).toBe('src/session-management/session.ts')
    expect(moved!.after).toContain('export function createSession')
    // Its own imports still resolve from the new location, and the project's
    // explicit `.ts` extension style is preserved rather than normalised away.
    for (const specifier of [
      '../db/client.ts',
      '../utils/ids.ts',
      '../utils/logger.ts',
      '../types/index.ts'
    ]) {
      expect(moved!.after).toContain(`from '${specifier}'`)
    }

    // ---- Everyone who imported it now points at the new location -------
    const changedPaths = changeSet.changes.map((c) => c.path).sort()
    expect(changedPaths).toContain('src/auth/index.ts')
    expect(changedPaths).toContain('src/auth/login.ts')
    expect(changedPaths).toContain('src/api/server.ts')
    expect(changedPaths).toContain('src/payments/checkout.ts')

    const login = changeSet.changes.find((c) => c.path === 'src/auth/login.ts')!
    expect(login.after).toContain("from '../session-management/session.ts'")
    expect(login.after).not.toContain("from './session.ts'")

    const checkout = changeSet.changes.find(
      (c) => c.path === 'src/payments/checkout.ts'
    )!
    expect(checkout.after).toContain("from '../session-management/session.ts'")

    // The rewrite does not stop at `src`: the project's own tests import the
    // module that moved, and they are fixed too — which is what makes the
    // generated project's test suite still pass below.
    expect(changedPaths).toContain('test/session.test.ts')
    expect(changedPaths).toContain('test/checkout.test.ts')
    const sessionTest = changeSet.changes.find(
      (c) => c.path === 'test/session.test.ts'
    )!
    expect(sessionTest.after).toContain(
      "from '../src/session-management/session.ts'"
    )
    expect(changeSet.changes).toHaveLength(9)

    // Nothing anywhere still imports the old path.
    for (const change of changeSet.changes) {
      if (change.after === null) continue
      expect(change.after).not.toMatch(/['"][^'"]*auth\/session(\.ts)?['"]/)
    }

    // ---- The graph and the code agree ----------------------------------
    expect(validateGraph(desired).filter((p) => p.severity === 'error')).toEqual([])
    const sessionModule = moduleNamed(desired, 'Session Management')
    expect(sessionModule.files).toContain('src/session-management/session.ts')
    expect(moduleNamed(desired, 'Auth').files).not.toContain('src/auth/session.ts')
    expect(changeSet.modulesAdded).toEqual(['Session Management'])

    // ---- Write it to a new directory and actually check it -------------
    const service = createService({ logger })
    const outputDirectory = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-out-')),
      'generated'
    )
    scratchDirs.push(path.dirname(outputDirectory))

    const result = await service.apply({
      projectRoot: root,
      changeSet,
      mode: 'new-directory',
      outputDirectory,
      createBackup: false,
      validate: true
    })

    expect(result.errors).toEqual([])
    expect(result.created).toContain('src/session-management/index.ts')
    expect(result.renamed).toEqual([
      { from: 'src/auth/session.ts', to: 'src/session-management/session.ts' }
    ])
    expect(result.appliedOperationIds.length).toBe(2)

    // The original project is untouched.
    expect(
      await fs
        .access(path.join(root, 'src/auth/session.ts'))
        .then(() => true)
        .catch(() => false)
    ).toBe(true)

    // The generated project really exists on disk, in the new shape.
    const onDisk = await fs.readFile(
      path.join(outputDirectory, 'src/session-management/session.ts'),
      'utf8'
    )
    expect(onDisk).toContain('export function createSession')
    expect(
      await fs
        .access(path.join(outputDirectory, 'src/auth/session.ts'))
        .then(() => true)
        .catch(() => false)
    ).toBe(false)
    // Unrelated files came along untouched.
    expect(
      await fs.readFile(path.join(outputDirectory, 'package.json'), 'utf8')
    ).toBe(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

    // ---- Validation: it type checks and its own tests pass -------------
    expect(result.validation).not.toBeNull()
    const typecheck = result.validation!.checks.find((c) =>
      c.name.includes('TypeScript')
    )!
    expect(typecheck.status, typecheck.output).toBe('passed')
    const tests = result.validation!.checks.find((c) => c.name === 'Project tests')!
    expect(tests.status, tests.output).toBe('passed')
    expect(result.validation!.passed).toBe(true)

    // ---- Re-analyzing the generated project sees the new architecture --
    const reanalyzed = await analyzeProject(outputDirectory)
    const names = reanalyzed.graph.modules.map((m) => m.name)
    expect(names).toContain('Session Management')
    const newSession = moduleNamed(reanalyzed.graph, 'Session Management')
    expect(newSession.files).toContain('src/session-management/session.ts')
    expect(moduleNamed(reanalyzed.graph, 'Auth').files).not.toContain(
      'src/auth/session.ts'
    )
    // Auth now depends on the new module, and that edge is backed by imports.
    const edge = reanalyzed.graph.edges.find(
      (e) =>
        e.from === moduleNamed(reanalyzed.graph, 'Auth').id &&
        e.to === newSession.id
    )
    expect(edge).toBeDefined()
    expect(edge!.verified).toBe(true)

    // The log told the user what happened, in order.
    const messages = events.map((e) => e.message)
    expect(messages.some((m) => m.includes('Create module'))).toBe(true)
    expect(messages.some((m) => m.includes('Move file'))).toBe(true)
    expect(events.some((e) => e.level === 'error')).toBe(false)
  }, 180_000)
})

describe('in-place generation with a backup', () => {
  it('previews, writes over the project, and can be rolled back', async () => {
    const root = await copySample('inplace')
    const { graph } = await analyzeProject(root)
    const service = createService()
    const utils = moduleNamed(graph, 'Utils')
    const db = moduleNamed(graph, 'Db')

    const operations = [
      op({
        type: 'move_file',
        file: 'src/utils/ids.ts',
        fromModuleId: utils.id,
        toModuleId: db.id
      })
    ]

    const changeSet = await service.plan({
      projectRoot: root,
      graph,
      operations,
      useAi: false
    })

    // The preview is generated from the same change set that gets written.
    const diffs = service.previewDiff(changeSet)
    expect(diffs.length).toBe(changeSet.changes.length)
    const movedDiff = diffs.find((d) => d.path === 'src/db/ids.ts')!
    expect(movedDiff.patch).toContain('src/utils/ids.ts')
    expect(diffs.some((d) => d.additions > 0)).toBe(true)

    const before = await fs.readFile(path.join(root, 'src/auth/password.ts'), 'utf8')
    expect(before).toContain("from '../utils/ids.ts'")

    const result = await service.apply({
      projectRoot: root,
      changeSet,
      mode: 'in-place',
      createBackup: true,
      validate: true
    })

    expect(result.errors).toEqual([])
    expect(result.backup).not.toBeNull()
    expect(result.backup!.fileCount).toBeGreaterThan(0)
    expect(result.validation!.passed).toBe(true)

    // The project on disk changed.
    const after = await fs.readFile(path.join(root, 'src/auth/password.ts'), 'utf8')
    expect(after).toContain("from '../db/ids.ts'")
    expect(
      await fs
        .access(path.join(root, 'src/utils/ids.ts'))
        .then(() => true)
        .catch(() => false)
    ).toBe(false)

    // And the backup puts it back.
    const restored = await restoreBackup(result.backup!.directory)
    expect(restored.errors).toEqual([])
    expect(restored.restored).toContain('src/utils/ids.ts')
    const rolledBack = await fs.readFile(
      path.join(root, 'src/auth/password.ts'),
      'utf8'
    )
    expect(rolledBack).toBe(before)
  }, 180_000)
})

describe('moving a responsibility as a symbol-level refactor', () => {
  it('moves exported functions into a new module and keeps the project compiling', async () => {
    const root = await copySample('symbols')
    const { graph } = await analyzeProject(root)
    const service = createService()
    const auth = moduleNamed(graph, 'Auth')

    const operations = [
      op({
        type: 'add_module',
        module: {
          id: 'tokens',
          name: 'Tokens',
          description: 'Signs and verifies opaque tokens.',
          responsibilities: ['Sign tokens', 'Verify tokens'],
          directory: 'src/tokens',
          publicInterface: []
        }
      }),
      op({
        type: 'move_symbol',
        symbol: 'signToken',
        fromFile: 'src/auth/tokens.ts',
        fromModuleId: auth.id,
        toModuleId: 'tokens',
        toFile: 'src/tokens/sign.ts',
        leaveReExport: false
      })
    ]

    const changeSet = await service.plan({
      projectRoot: root,
      graph,
      operations,
      useAi: false
    })

    const outcomes = changeSet.outcomes
    expect(outcomes.every((o) => o.status === 'applied')).toBe(true)

    const signFile = changeSet.changes.find((c) => c.path === 'src/tokens/sign.ts')!
    // The declaration moved with its JSDoc, and its dependency came along.
    expect(signFile.after).toContain('export function signToken')
    expect(signFile.after).toContain('Signs a payload into an opaque token')
    expect(signFile.after).toContain('fnv1a')
    expect(signFile.after).toMatch(/from '\.\.\/utils\/ids\.ts'/)
    // `SECRET` was local to the source file, so it is imported back.
    expect(signFile.after).toContain('SECRET')

    const source = changeSet.changes.find((c) => c.path === 'src/auth/tokens.ts')!
    expect(source.after).not.toContain('export function signToken')
    expect(source.after).toContain('export function verifyToken')
    // The constant it shared is now exported.
    expect(source.after).toMatch(/export const SECRET/)

    // The barrel that re-exported it now points at the new module.
    const barrel = changeSet.changes.find((c) => c.path === 'src/auth/index.ts')!
    expect(barrel.after).toContain('signToken')
    expect(barrel.after).toMatch(/from '\.\.\/tokens\/sign\.ts'/)

    const outputDirectory = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-sym-')),
      'generated'
    )
    scratchDirs.push(path.dirname(outputDirectory))
    const result = await service.apply({
      projectRoot: root,
      changeSet,
      mode: 'new-directory',
      outputDirectory,
      createBackup: false,
      validate: true
    })

    expect(result.errors).toEqual([])
    const typecheck = result.validation!.checks.find((c) =>
      c.name.includes('TypeScript')
    )!
    expect(typecheck.status, typecheck.output).toBe('passed')
    const tests = result.validation!.checks.find((c) => c.name === 'Project tests')!
    expect(tests.status, tests.output).toBe('passed')
  }, 180_000)
})

describe('operations that cannot be carried out', () => {
  it('refuses to sever a real dependency and says exactly why', async () => {
    const root = await copySample('refuse')
    const { graph } = await analyzeProject(root)
    const service = createService()
    const auth = moduleNamed(graph, 'Auth')
    const db = moduleNamed(graph, 'Db')

    const changeSet = await service.plan({
      projectRoot: root,
      graph,
      operations: [op({ type: 'remove_dependency', from: auth.id, to: db.id })],
      useAi: false
    })

    expect(changeSet.changes).toEqual([])
    expect(changeSet.outcomes[0].status).toBe('unsupported')
    expect(changeSet.outcomes[0].message).toContain('real import')
    expect(changeSet.breakingChanges.length).toBeGreaterThan(0)
    expect(changeSet.breakingChanges[0]).toMatch(/src\/auth\/.*imports/)
  }, 120_000)

  it('reports an AI-only operation as unsupported when no key is configured', async () => {
    const root = await copySample('noai')
    const { graph } = await analyzeProject(root)
    const service = createService()
    const auth = moduleNamed(graph, 'Auth')
    const db = moduleNamed(graph, 'Db')

    const changeSet = await service.plan({
      projectRoot: root,
      graph,
      operations: [
        op({
          type: 'move_responsibility',
          responsibility: 'Create session',
          fromModuleId: auth.id,
          toModuleId: db.id
        })
      ],
      useAi: true
    })

    expect(changeSet.changes).toEqual([])
    expect(changeSet.aiSkipped).toBe(true)
    expect(changeSet.outcomes[0].status).toBe('unsupported')
    expect(changeSet.outcomes[0].message).toContain('AI model')
  }, 120_000)

  it('reports a metadata-only edit as metadata-only, not as applied', async () => {
    const root = await copySample('metadata')
    const { graph } = await analyzeProject(root)
    const service = createService()
    const auth = moduleNamed(graph, 'Auth')

    const changeSet = await service.plan({
      projectRoot: root,
      graph,
      operations: [
        op({
          type: 'update_module',
          moduleId: auth.id,
          description: 'Authenticates callers.'
        })
      ],
      useAi: false
    })

    expect(changeSet.changes).toEqual([])
    expect(changeSet.outcomes[0].status).toBe('metadata_only')
  }, 120_000)

  it('fails an operation whose target does not exist, without touching anything', async () => {
    const root = await copySample('bogus')
    const { graph } = await analyzeProject(root)
    const service = createService()

    const changeSet = await service.plan({
      projectRoot: root,
      graph,
      operations: [
        op({
          type: 'move_file',
          file: 'src/auth/session.ts',
          fromModuleId: 'does-not-exist',
          toModuleId: moduleNamed(graph, 'Db').id
        })
      ],
      useAi: false
    })

    expect(changeSet.changes).toEqual([])
    expect(changeSet.outcomes[0].status).toBe('unsupported')
    expect(changeSet.outcomes[0].message).toContain('Enable AI assistance')
  }, 120_000)
})

describe('the operation log and the architecture diff agree', () => {
  it('replaying the log reproduces the desired graph the diff describes', async () => {
    const root = await copySample('diff')
    const { graph } = await analyzeProject(root)
    const auth = moduleNamed(graph, 'Auth')

    const operations = [
      op({
        type: 'add_module',
        module: {
          id: 'session-management',
          name: 'Session Management',
          description: 'Owns sessions.',
          responsibilities: [],
          directory: 'src/session-management',
          publicInterface: []
        }
      }),
      op({
        type: 'move_file',
        file: 'src/auth/session.ts',
        fromModuleId: auth.id,
        toModuleId: 'session-management'
      }),
      op({ type: 'rename_module', moduleId: auth.id, name: 'Authentication' })
    ]

    const replayed = applyOperations(graph, operations)
    expect(replayed.failures).toEqual([])

    const diff = diffArchitectures(graph, replayed.graph)
    expect(diff.empty).toBe(false)
    expect(diff.addedModules).toEqual(['session-management'])
    expect(diff.renamedModules.map((r) => r.to)).toContain('Authentication')
    expect(diff.movedFiles).toEqual([
      {
        file: 'src/session-management/session.ts',
        from: auth.id,
        to: 'session-management'
      }
    ])

    // Replaying the *derived* operations on the original graph lands in the
    // same architecture, which is what a remote collaborator would do.
    const derived = diff.operations.map((body) => op(body))
    const rebuilt = applyOperations(graph, derived)
    expect(rebuilt.graph.modules.map((m) => m.id).sort()).toEqual(
      replayed.graph.modules.map((m) => m.id).sort()
    )
    expect(moduleNamed(rebuilt.graph, 'Authentication').files.sort()).toEqual(
      moduleNamed(replayed.graph, 'Authentication').files.sort()
    )
  }, 120_000)

  it('rejects an operation that would break a graph invariant', async () => {
    const root = await copySample('invariant')
    const { graph } = await analyzeProject(root)
    const auth = moduleNamed(graph, 'Auth')

    const duplicate = applyOperation(graph, {
      type: 'add_module',
      module: {
        id: auth.id,
        name: 'Clash',
        description: '',
        responsibilities: [],
        directory: null,
        publicInterface: []
      }
    })
    expect(duplicate.ok).toBe(false)

    const selfDep = applyOperation(graph, {
      type: 'add_dependency',
      from: auth.id,
      to: auth.id,
      kind: 'depends_on'
    })
    expect(selfDep.ok).toBe(false)
  }, 120_000)
})
