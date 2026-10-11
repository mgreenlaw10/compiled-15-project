import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  applyMovesWithImportRewrite,
  buildSpecifier,
  findImporters,
  inferQuoteKind,
  inferSpecifierStyle,
  rewriteSpecifier,
  specifierStyle,
  targetExtension
} from '../../src/core/transform/imports'
import { removeUnusedImports } from '../../src/core/transform/ops/move-symbol'
import { createTransformProject } from '../../src/core/transform/imports'
import { VirtualWorkspace } from '../../src/core/transform/workspace'
import { planChanges } from '../../src/core/transform/engine'
import { preflight, resolveInside } from '../../src/core/output/writer'
import { diffForChange, summarizeChangeSet } from '../../src/core/output/differ'
import { validateProjectPath } from '../../src/core/ai/tools'
import {
  basename,
  commonDirectory,
  isWithin,
  normalizeRel,
  relativeSpecifier,
  resolveSpecifier,
  stripExtension
} from '../../src/shared/util/paths'
import { createEdge, createGraph, createModule } from '../../src/shared/graph/model'
import type { ChangeSet } from '../../src/shared/types/generation'
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

describe('path utilities', () => {
  it('normalizes and inspects paths', () => {
    expect(normalizeRel('./src//auth/../db/client.ts')).toBe('src/db/client.ts')
    expect(normalizeRel('a\\b\\c.ts')).toBe('a/b/c.ts')
    expect(basename('src/a/b.ts')).toBe('b.ts')
    expect(stripExtension('src/a/b.test.ts')).toBe('src/a/b.test')
    expect(isWithin('src', 'src/a/b.ts')).toBe(true)
    expect(isWithin('src/a', 'src/b.ts')).toBe(false)
    expect(isWithin('', 'anything.ts')).toBe(true)
  })

  it('finds the common directory of a file set', () => {
    expect(
      commonDirectory(['src/auth/a.ts', 'src/auth/deep/b.ts', 'src/auth/c.ts'])
    ).toBe('src/auth')
    expect(commonDirectory(['src/a.ts', 'lib/b.ts'])).toBe('')
    expect(commonDirectory([])).toBe('')
  })

  it('builds relative specifiers the way TypeScript expects', () => {
    expect(relativeSpecifier('src/auth/login.ts', 'src/db/client.ts')).toBe(
      '../db/client'
    )
    expect(relativeSpecifier('src/auth/login.ts', 'src/auth/session.ts')).toBe(
      './session'
    )
    // `/index` collapses by default, and can be kept.
    expect(relativeSpecifier('src/api/routes.ts', 'src/auth/index.ts')).toBe('../auth')
    expect(
      relativeSpecifier('src/api/routes.ts', 'src/auth/index.ts', {
        collapseIndex: false
      })
    ).toBe('../auth/index')
    expect(
      relativeSpecifier('src/api/routes.ts', 'src/auth/index.ts', {
        collapseIndex: false,
        extension: '.ts'
      })
    ).toBe('../auth/index.ts')
  })

  it('resolves a specifier back to a path', () => {
    expect(resolveSpecifier('src/auth/login.ts', '../db/client')).toBe('src/db/client')
    expect(resolveSpecifier('src/auth/login.ts', 'react')).toBe('react')
  })
})

describe('specifier style', () => {
  it('reads the style out of a specifier', () => {
    expect(specifierStyle('./session')).toEqual({
      extension: null,
      explicitIndex: false
    })
    expect(specifierStyle('./session.ts')).toEqual({
      extension: '.ts',
      explicitIndex: false
    })
    expect(specifierStyle('../auth/index')).toEqual({
      extension: null,
      explicitIndex: true
    })
  })

  it('keeps a .js specifier pointing at a .ts file written as .js', () => {
    expect(targetExtension({ extension: '.js', explicitIndex: false }, 'a/b.ts')).toBe(
      '.js'
    )
    expect(targetExtension({ extension: '.ts', explicitIndex: false }, 'a/b.tsx')).toBe(
      '.tsx'
    )
    expect(targetExtension({ extension: null, explicitIndex: false }, 'a/b.ts')).toBeNull()
  })

  it('infers a file’s convention from the imports it already has', () => {
    const withExtensions = `
      import { a } from './a.ts'
      import { b } from '../b/index.ts'
      import x from 'react'
    `
    // One of the two relative imports names `index`, which is not a majority.
    expect(inferSpecifierStyle(withExtensions)).toEqual({
      extension: '.ts',
      explicitIndex: false
    })
    expect(
      inferSpecifierStyle(`
        import { a } from './a/index.ts'
        import { b } from '../b/index.ts'
        import { c } from './c.ts'
      `)
    ).toEqual({ extension: '.ts', explicitIndex: true })

    const without = `
      import { a } from './a'
      import { b } from '../b'
    `
    expect(inferSpecifierStyle(without)).toEqual({
      extension: null,
      explicitIndex: false
    })

    // Nothing to go on: the caller's fallback is used.
    expect(
      inferSpecifierStyle('export const x = 1', {
        extension: '.ts',
        explicitIndex: false
      })
    ).toEqual({ extension: '.ts', explicitIndex: false })
  })

  it('infers quote style', () => {
    expect(inferQuoteKind(`import a from 'a'\nimport b from 'b'`)).toBe("'")
    expect(inferQuoteKind(`import a from "a"\nimport b from "b"`)).toBe('"')
  })

  it('rewrites a specifier for a new location, keeping the style', () => {
    expect(
      rewriteSpecifier('src/session/session.ts', 'src/db/client.ts', '../db/client.ts')
    ).toBe('../db/client.ts')
    expect(
      rewriteSpecifier('src/a/deep/f.ts', 'src/b/g.ts', './g')
    ).toBe('../../b/g')
    expect(
      buildSpecifier('src/a/f.ts', 'src/b/index.ts', {
        extension: '.ts',
        explicitIndex: true
      })
    ).toBe('../b/index.ts')
  })

  it('never collapses an index file while keeping its extension', () => {
    // `../b.ts` would not resolve to `src/b/index.ts`, so the specifier either
    // names index in full or drops the extension entirely.
    expect(
      buildSpecifier('src/a/f.ts', 'src/b/index.ts', {
        extension: '.ts',
        explicitIndex: false
      })
    ).toBe('../b/index.ts')
    expect(
      buildSpecifier('src/a/f.ts', 'src/b/index.ts', {
        extension: null,
        explicitIndex: false
      })
    ).toBe('../b')
    expect(
      rewriteSpecifier('src/a/f.ts', 'src/b/index.ts', './old.ts')
    ).toBe('../b/index.ts')
  })
})

describe('the virtual workspace', () => {
  const initial: [string, string][] = [
    ['src/a.ts', 'export const a = 1\n'],
    ['src/b.ts', 'export const b = 2\n']
  ]
  const options = { reason: 'test', operationId: 'op1' }

  it('starts clean and tracks edits', () => {
    const ws = new VirtualWorkspace('/p', initial)
    expect(ws.clean).toBe(true)
    expect(ws.changes()).toEqual([])
    expect(ws.listFiles()).toEqual(['src/a.ts', 'src/b.ts'])

    ws.write('src/a.ts', 'export const a = 99\n', options)
    expect(ws.clean).toBe(false)
    const changes = ws.changes()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      kind: 'modify',
      path: 'src/a.ts',
      before: 'export const a = 1\n',
      after: 'export const a = 99\n'
    })
  })

  it('records creates, deletes and moves distinctly', () => {
    const ws = new VirtualWorkspace('/p', initial)
    ws.create('src/c.ts', 'export const c = 3\n', options)
    ws.delete('src/b.ts', options)
    ws.move('src/a.ts', 'lib/a.ts', options)

    const byKind = new Map(ws.changes().map((c) => [c.kind, c]))
    expect(byKind.get('create')!.path).toBe('src/c.ts')
    expect(byKind.get('create')!.before).toBeNull()
    expect(byKind.get('delete')!.path).toBe('src/b.ts')
    expect(byKind.get('delete')!.after).toBeNull()
    expect(byKind.get('rename')).toMatchObject({
      path: 'lib/a.ts',
      previousPath: 'src/a.ts'
    })
    expect(ws.moveMap().get('src/a.ts')).toBe('lib/a.ts')
    expect(ws.currentPathOf('src/a.ts')).toBe('lib/a.ts')
  })

  it('reports a moved-and-edited file once, as a rename', () => {
    const ws = new VirtualWorkspace('/p', initial)
    ws.write('src/a.ts', 'export const a = 7\n', options)
    ws.move('src/a.ts', 'lib/a.ts', options)
    const changes = ws.changes()
    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('rename')
    expect(changes[0].after).toBe('export const a = 7\n')
    expect(changes[0].before).toBe('export const a = 1\n')
  })

  it('refuses impossible operations', () => {
    const ws = new VirtualWorkspace('/p', initial)
    expect(() => ws.create('src/a.ts', 'x', options)).toThrow(/already exists/)
    expect(() => ws.move('src/missing.ts', 'x.ts', options)).toThrow(/no such file/)
    expect(() => ws.move('src/a.ts', 'src/b.ts', options)).toThrow(/target exists/)
    expect(ws.delete('src/missing.ts', options)).toBe(false)
  })
})

describe('import rewriting', () => {
  function workspace(): VirtualWorkspace {
    return new VirtualWorkspace('/p', [
      [
        'src/auth/login.ts',
        [
          "import { createSession } from './session'",
          "import { findUser } from '../db/users'",
          'export function login() {',
          '  return createSession(findUser())',
          '}',
          ''
        ].join('\n')
      ],
      [
        'src/auth/session.ts',
        [
          "import { db } from '../db/client'",
          'export function createSession() {',
          '  return db',
          '}',
          ''
        ].join('\n')
      ],
      [
        'src/auth/index.ts',
        ["export { createSession } from './session'", ''].join('\n')
      ],
      ['src/db/client.ts', 'export const db = {}\n'],
      ['src/db/users.ts', 'export function findUser() { return 1 }\n'],
      [
        'src/api/routes.ts',
        [
          "import { createSession } from '../auth/session'",
          "const lazy = () => import('../auth/session')",
          "const legacy = require('../auth/session')",
          'export const routes = [createSession, lazy, legacy]',
          ''
        ].join('\n')
      ]
    ])
  }

  it('rewrites the moved file’s own imports and every importer', () => {
    const ws = workspace()
    const report = applyMovesWithImportRewrite(
      ws,
      new Map([['src/auth/session.ts', 'src/sessions/session.ts']]),
      { reason: 'move', operationId: 'op1' }
    )

    expect(report.rewritten).toBeGreaterThanOrEqual(5)
    expect(report.unresolved).toEqual([])

    // The moved file's own import is now one level deeper.
    expect(ws.read('src/sessions/session.ts')).toContain("from '../db/client'")

    // Static imports, barrel re-exports, dynamic imports and require() calls.
    expect(ws.read('src/auth/login.ts')).toContain(
      "from '../sessions/session'"
    )
    expect(ws.read('src/auth/index.ts')).toContain(
      "from '../sessions/session'"
    )
    const routes = ws.read('src/api/routes.ts')!
    expect(routes).toContain("from '../sessions/session'")
    expect(routes).toContain("import('../sessions/session')")
    expect(routes).toContain("require('../sessions/session')")
    expect(routes).not.toContain('auth/session')
  })

  it('leaves unrelated imports alone', () => {
    const ws = workspace()
    applyMovesWithImportRewrite(
      ws,
      new Map([['src/auth/session.ts', 'src/sessions/session.ts']]),
      { reason: 'move', operationId: 'op1' }
    )
    expect(ws.read('src/auth/login.ts')).toContain("from '../db/users'")
    expect(ws.read('src/db/client.ts')).toBe('export const db = {}\n')
  })

  it('finds the importers of a file, with the symbols they take', () => {
    const importers = findImporters(workspace(), 'src/auth/session.ts')
    const paths = importers.map((i) => i.file).sort()
    expect(paths).toContain('src/auth/login.ts')
    expect(paths).toContain('src/auth/index.ts')
    expect(paths).toContain('src/api/routes.ts')
    expect(
      importers.find((i) => i.file === 'src/auth/login.ts')!.symbols
    ).toEqual(['createSession'])
  })

  it('does nothing when there is nothing to move', () => {
    const ws = workspace()
    const report = applyMovesWithImportRewrite(ws, new Map(), {
      reason: 'noop',
      operationId: 'op1'
    })
    expect(report.rewritten).toBe(0)
    expect(ws.clean).toBe(true)
  })

  it('reports an import it could not resolve instead of guessing', () => {
    const ws = new VirtualWorkspace('/p', [
      ['src/a.ts', "import { x } from './does-not-exist'\nexport const a = x\n"]
    ])
    const report = applyMovesWithImportRewrite(
      ws,
      new Map([['src/a.ts', 'lib/a.ts']]),
      { reason: 'move', operationId: 'op1' }
    )
    expect(report.unresolved).toEqual([
      { file: 'src/a.ts', specifier: './does-not-exist', line: 1 }
    ])
    // The broken specifier is left exactly as written.
    expect(ws.read('lib/a.ts')).toContain("'./does-not-exist'")
  })
})

describe('unused import removal', () => {
  it('drops bindings the file no longer uses, and keeps the rest', () => {
    const project = createTransformProject()
    const sf = project.createSourceFile(
      'a.ts',
      [
        "import { used, unused } from './x'",
        "import defaultUnused from './y'",
        "import * as ns from './z'",
        "import './side-effect'",
        'export const value = used + ns.thing',
        ''
      ].join('\n')
    )
    const removed = removeUnusedImports(sf)
    expect(removed.sort()).toEqual(['defaultUnused', 'unused'])

    const text = sf.getFullText()
    expect(text).toContain('used')
    expect(text).not.toContain('unused')
    expect(text).not.toContain('defaultUnused')
    expect(text).toContain('ns')
    // A bare side-effect import is never "unused".
    expect(text).toContain("'./side-effect'")
  })

  it('keeps a binding used only in a type position', () => {
    const project = createTransformProject()
    const sf = project.createSourceFile(
      'a.ts',
      ["import type { Shape } from './t'", 'export const f = (s: Shape) => s', ''].join(
        '\n'
      )
    )
    expect(removeUnusedImports(sf)).toEqual([])
    expect(sf.getFullText()).toContain('Shape')
  })
})

describe('writer safety', () => {
  it('refuses paths that escape the destination', () => {
    const root = path.resolve('/tmp/project')
    expect(resolveInside(root, 'src/a.ts')).toBe(path.join(root, 'src/a.ts'))
    expect(() => resolveInside(root, '../escape.ts')).toThrow(/outside the project/)
    expect(() => resolveInside(root, '')).toThrow()
    // A traversal segment is refused, not quietly collapsed.
    expect(() => resolveInside(root, 'src/../a.ts')).toThrow(/".." segment/)
    expect(() => resolveInside(root, 'src\\..\\a.ts')).toThrow(/".." segment/)
  })

  it('pre-flights a change set against the real directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-pre-'))
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true })
      await fs.writeFile(path.join(dir, 'src/exists.ts'), 'x', 'utf8')

      const changeSet: ChangeSet = {
        changes: [
          {
            kind: 'create',
            path: 'src/exists.ts',
            before: null,
            after: 'y',
            operationIds: ['op1'],
            reason: 'clash'
          },
          {
            kind: 'modify',
            path: 'src/missing.ts',
            before: 'a',
            after: 'b',
            operationIds: ['op1'],
            reason: 'absent'
          },
          {
            kind: 'create',
            path: '../outside.ts',
            before: null,
            after: 'nope',
            operationIds: ['op1'],
            reason: 'escape'
          }
        ],
        outcomes: [],
        modulesAdded: [],
        modulesRemoved: [],
        modulesRenamed: [],
        breakingChanges: [],
        aiSkipped: false
      }

      const problems = await preflight(dir, changeSet)
      expect(problems.some((p) => p.includes('already exists'))).toBe(true)
      expect(problems.some((p) => p.includes('does not exist'))).toBe(true)
      expect(problems.some((p) => p.includes('outside the project'))).toBe(true)

      // The directory is untouched: preflight writes nothing.
      expect(await fs.readFile(path.join(dir, 'src/exists.ts'), 'utf8')).toBe('x')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('diffs', () => {
  it('counts additions and deletions', () => {
    const preview = diffForChange({
      kind: 'modify',
      path: 'a.ts',
      before: 'const a = 1\nconst b = 2\n',
      after: 'const a = 1\nconst b = 3\nconst c = 4\n',
      operationIds: ['op1'],
      reason: 'edit'
    })
    expect(preview.path).toBe('a.ts')
    expect(preview.additions).toBe(2)
    expect(preview.deletions).toBe(1)
    expect(preview.patch).toContain('-const b = 2')
    expect(preview.patch).toContain('+const b = 3')
  })

  it('labels a rename with both paths', () => {
    const preview = diffForChange({
      kind: 'rename',
      path: 'b.ts',
      previousPath: 'a.ts',
      before: 'x\n',
      after: 'x\n',
      operationIds: ['op1'],
      reason: 'move'
    })
    expect(preview.patch).toContain('a/a.ts')
    expect(preview.patch).toContain('b/b.ts')
  })

  it('summarizes a change set', () => {
    expect(
      summarizeChangeSet({
        changes: [
          {
            kind: 'create',
            path: 'a.ts',
            before: null,
            after: 'x',
            operationIds: [],
            reason: ''
          },
          {
            kind: 'rename',
            path: 'c.ts',
            previousPath: 'b.ts',
            before: 'x',
            after: 'x',
            operationIds: [],
            reason: ''
          }
        ],
        outcomes: [],
        modulesAdded: [],
        modulesRemoved: [],
        modulesRenamed: [],
        breakingChanges: [],
        aiSkipped: false
      })
    ).toBe('1 created, 1 moved')
  })
})

describe('AI tool path validation', () => {
  it('accepts project-relative paths and rejects everything else', () => {
    expect(validateProjectPath('src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(validateProjectPath('./src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(validateProjectPath('/etc/passwd')).toHaveProperty('error')
    expect(validateProjectPath('C:\\Windows\\system32')).toHaveProperty('error')
    expect(validateProjectPath('../../escape.ts')).toHaveProperty('error')
    expect(validateProjectPath('node_modules/pkg/index.js')).toHaveProperty('error')
    expect(validateProjectPath('.git/config')).toHaveProperty('error')
    expect(validateProjectPath('   ')).toHaveProperty('error')
  })
})

describe('the engine on a hand-built graph', () => {
  const graph = createGraph({
    projectRoot: '/p',
    name: 'tiny',
    modules: [
      createModule({
        id: 'a',
        name: 'A',
        directory: 'src/a',
        files: ['src/a/one.ts'],
        origin: 'analysis'
      }),
      createModule({
        id: 'b',
        name: 'B',
        directory: 'src/b',
        files: ['src/b/two.ts'],
        origin: 'analysis'
      })
    ],
    edges: [createEdge({ from: 'b', to: 'a', verified: true, weight: 1 })]
  })

  const files: [string, string][] = [
    ['src/a/one.ts', 'export const one = 1\n'],
    ['src/b/two.ts', "import { one } from '../a/one'\nexport const two = one + 1\n"]
  ]

  it('creates a module with honest placeholder exports', async () => {
    const { changeSet } = await planChanges(
      graph,
      [
        op({
          type: 'add_module',
          module: {
            id: 'c',
            name: 'C',
            description: 'A new module.',
            responsibilities: ['Do the thing'],
            directory: 'src/c',
            publicInterface: ['doThing', 'not an identifier']
          }
        })
      ],
      files
    )

    expect(changeSet.outcomes[0].status).toBe('applied')
    const created = changeSet.changes[0]
    expect(created.path).toBe('src/c/index.ts')
    expect(created.after).toContain('A new module.')
    expect(created.after).toContain('Do the thing')
    expect(created.after).toContain('export function doThing')
    // The stub throws rather than returning something plausible.
    expect(created.after).toContain('has no implementation yet')
    expect(changeSet.outcomes[0].warnings.join(' ')).toMatch(/placeholder export/)
    expect(changeSet.outcomes[0].warnings.join(' ')).toMatch(/not valid identifiers/)
  })

  it('reports a graph-only module as metadata, not as applied', async () => {
    const { changeSet } = await planChanges(
      graph,
      [
        op({
          type: 'add_module',
          module: {
            id: 'c',
            name: 'C',
            description: '',
            responsibilities: [],
            directory: null,
            publicInterface: []
          }
        })
      ],
      files
    )
    expect(changeSet.changes).toEqual([])
    expect(changeSet.outcomes[0].status).toBe('metadata_only')
  })

  it('renames a directory and fixes the imports that pointed into it', async () => {
    const { changeSet } = await planChanges(
      graph,
      [
        op({
          type: 'rename_module',
          moduleId: 'a',
          name: 'Alpha',
          directory: 'src/alpha'
        })
      ],
      files
    )

    expect(changeSet.outcomes[0].status).toBe('applied')
    const moved = changeSet.changes.find((c) => c.kind === 'rename')!
    expect(moved.previousPath).toBe('src/a/one.ts')
    expect(moved.path).toBe('src/alpha/one.ts')
    const importer = changeSet.changes.find((c) => c.path === 'src/b/two.ts')!
    expect(importer.after).toContain("from '../alpha/one'")
  })

  it('warns before deleting files that are still imported', async () => {
    const { changeSet } = await planChanges(
      graph,
      [op({ type: 'delete_module', moduleId: 'a', fileDisposition: 'delete' })],
      files
    )
    expect(changeSet.outcomes[0].status).toBe('partial')
    expect(changeSet.breakingChanges.join(' ')).toMatch(
      /src\/b\/two\.ts imports src\/a\/one\.ts/
    )
    expect(changeSet.changes.map((c) => c.kind)).toEqual(['delete'])
  })

  it('requests AI reconciliation for a graph mismatch, and keeps going', async () => {
    const { changeSet } = await planChanges(
      graph,
      [
        op({ type: 'rename_module', moduleId: 'nope', name: 'X' }),
        op({ type: 'update_module', moduleId: 'a', description: 'fine' })
      ],
      files
    )
    expect(changeSet.outcomes[0].status).toBe('unsupported')
    expect(changeSet.outcomes[0].message).toContain('Enable AI assistance')
    expect(changeSet.outcomes[1].status).toBe('metadata_only')
    expect(changeSet.changes).toEqual([])
  })

  it('skips the remaining operations when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { changeSet } = await planChanges(
      graph,
      [op({ type: 'update_module', moduleId: 'a', description: 'x' })],
      files,
      { signal: controller.signal }
    )
    expect(changeSet.outcomes[0].status).toBe('skipped')
  })
})
