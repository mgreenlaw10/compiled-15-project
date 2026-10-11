/**
 * Conflict detection and write-scope tests.
 *
 * The acceptance criteria call for one demonstration specifically: Agent A
 * changes a public function, Agent B depends on it, and the system reports the
 * incompatibility instead of silently accepting an unsafe change. That is the
 * first `describe` below.
 *
 * These are pure-function tests over synthetic graphs, so they are fast and
 * deterministic. The Git half is covered by `tests/integration/collab-sync.test.ts`
 * against real clones.
 */

import { describe, expect, it } from 'vitest'

import type {
  ArchitectureGraph,
  ModuleNode
} from '../../src/shared/types/architecture'
import type {
  ProgramSymbol,
  SymbolRelationship
} from '../../src/shared/types/program'
import {
  checkScope,
  describeScopeCheck,
  detectConflicts,
  diffPublicSurface,
  externalDependentsOf,
  formatConflictReport,
  isSharedConfigPath,
  ownerOf
} from '../../src/core/collab'

// ---------------------------------------------------------------------------
// Builders. Verbose shapes, so each test states only what it cares about.
// ---------------------------------------------------------------------------

function symbol(partial: Partial<ProgramSymbol> & { id: string; name: string }): ProgramSymbol {
  return {
    qualifiedName: partial.name,
    scope: '',
    kind: 'function',
    language: 'typescript',
    accessibility: 'public',
    linkage: 'external',
    publiclyAccessible: true,
    signature: `${partial.name}(): void`,
    parameters: [],
    returnType: 'void',
    exceptions: [],
    fields: [],
    bases: [],
    description: '',
    descriptionOrigin: 'source',
    source: { file: 'src/a/index.ts', start: 0, end: 0, line: 1, endLine: 1, column: 0 },
    nameSource: { file: 'src/a/index.ts', start: 0, end: 0, line: 1, endLine: 1, column: 0 },
    signatureSource: {
      file: 'src/a/index.ts',
      start: 0,
      end: 0,
      line: 1,
      endLine: 1,
      column: 0
    },
    sourceText: '',
    definition: true,
    version: 1,
    ...partial
  } as ProgramSymbol
}

function relationship(from: string, to: string): SymbolRelationship {
  return {
    id: `${from}->${to}`,
    kind: 'call',
    fromSymbolId: from,
    toSymbolId: to,
    targetName: to,
    source: { file: '', start: 0, end: 0, line: 1, endLine: 1, column: 0 },
    resolution: 'resolved',
    origin: 'static',
    assumptions: [],
    conditional: false,
    version: 1
  } as SymbolRelationship
}

function module(id: string, directory: string, files: string[]): ModuleNode {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    description: '',
    responsibilities: [],
    files,
    symbols: [],
    publicInterface: [],
    directory,
    externalDependencies: [],
    origin: 'static',
    metadata: {
      loc: 10,
      confidence: 0.9,
      confidenceBasis: 'static',
      notes: [],
      tags: [],
      // Deprecated placeholders: ownership lives on the coordination branch.
      owner: null,
      lockedBy: null
    },
    version: 1,
    components: {
      interface: { functionIds: [], typeIds: [] },
      implementation: { symbolIds: [], observedDescription: '', desiredDescription: null, descriptionOrigin: 'heuristic' },
      dataStructures: { symbolIds: [] },
      contracts: { contractIds: [] }
    }
  } as ModuleNode
}

function graph(options: {
  modules: ModuleNode[]
  symbols: ProgramSymbol[]
  relationships?: SymbolRelationship[]
  contracts?: ArchitectureGraph['program']['contracts']
}): ArchitectureGraph {
  return {
    schemaVersion: 1,
    projectRoot: '/p',
    name: 'demo',
    modules: options.modules,
    edges: [],
    unassignedFiles: [],
    version: 1,
    analysis: {} as ArchitectureGraph['analysis'],
    program: {
      symbols: options.symbols,
      relationships: options.relationships ?? [],
      contracts: options.contracts ?? [],
      fileRelationships: [],
      assumptions: []
    }
  } as ArchitectureGraph
}

/**
 * The scenario from the acceptance criteria: `validateToken` lives in
 * Authentication and is called from Payments.
 */
function authAndPayments(validateTokenReturns: string): ArchitectureGraph {
  return graph({
    modules: [
      module('authentication', 'src/auth', ['src/auth/index.ts']),
      module('payments', 'src/payments', ['src/payments/index.ts'])
    ],
    symbols: [
      symbol({
        id: 'sym:validateToken',
        name: 'validateToken',
        qualifiedName: 'Authentication.validateToken',
        returnType: validateTokenReturns,
        signature: `validateToken(token: string): ${validateTokenReturns}`,
        parameters: [
          { name: 'token', type: 'string', optional: false, variadic: false }
        ],
        source: {
          file: 'src/auth/index.ts',
          start: 0,
          end: 0,
          line: 1,
          endLine: 3,
          column: 0
        }
      }),
      symbol({
        id: 'sym:charge',
        name: 'charge',
        qualifiedName: 'Payments.charge',
        source: {
          file: 'src/payments/index.ts',
          start: 0,
          end: 0,
          line: 1,
          endLine: 5,
          column: 0
        }
      })
    ],
    relationships: [relationship('sym:charge', 'sym:validateToken')]
  })
}

// ---------------------------------------------------------------------------

describe('interface conflicts across modules', () => {
  const base = authAndPayments('boolean')
  const changed = authAndPayments('TokenValidationResult')

  it('notices a changed return type on a public symbol', () => {
    const changes = diffPublicSurface(base, changed)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      symbolId: 'sym:validateToken',
      kind: 'return_type',
      before: 'boolean',
      after: 'TokenValidationResult',
      moduleId: 'authentication'
    })
  })

  it('finds the module that depends on it', () => {
    const dependents = externalDependentsOf(base, 'sym:validateToken', 'authentication')
    expect(dependents.map((d) => d.moduleId)).toEqual(['payments'])
  })

  it('reports the incompatibility instead of accepting the change', () => {
    const conflicts = detectConflicts({
      baseGraph: base,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: ['src/auth/index.ts'],
        graph: changed
      }
    })

    const interfaceConflict = conflicts.find((c) => c.kind === 'interface')
    expect(interfaceConflict).toBeDefined()
    expect(interfaceConflict!.summary).toContain('validateToken')
    expect(interfaceConflict!.explanation).toContain('boolean')
    expect(interfaceConflict!.explanation).toContain('TokenValidationResult')
    // Named in architectural terms, not as a file path.
    expect(interfaceConflict!.explanation).toContain('Payments')
    expect(interfaceConflict!.affectedModuleIds).toEqual(['payments'])
    expect(interfaceConflict!.symbolIds).toEqual(['sym:validateToken'])
  })

  it('treats a signature change as suspected and a removal as proven', () => {
    const [changedConflict] = detectConflicts({
      baseGraph: base,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: [],
        graph: changed
      }
    }).filter((c) => c.kind === 'interface')
    // Not yet type-checked, so a warning rather than a claim.
    expect(changedConflict.severity).toBe('warning')

    const removed = graph({
      modules: base.modules,
      symbols: base.program.symbols.filter((s) => s.id !== 'sym:validateToken'),
      relationships: base.program.relationships
    })
    const [removalConflict] = detectConflicts({
      baseGraph: base,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: [],
        graph: removed
      }
    }).filter((c) => c.kind === 'interface')
    // A caller of something that no longer exists provably breaks.
    expect(removalConflict.severity).toBe('blocking')
    expect(removalConflict.explanation).toContain('stop compiling')
  })

  it('stays quiet about churn nobody outside the module can see', () => {
    const withPrivate = graph({
      modules: base.modules,
      symbols: [
        ...base.program.symbols,
        symbol({
          id: 'sym:helper',
          name: 'helper',
          publiclyAccessible: false,
          accessibility: 'private'
        })
      ],
      relationships: base.program.relationships
    })
    const after = graph({
      modules: base.modules,
      symbols: withPrivate.program.symbols.map((s) =>
        s.id === 'sym:helper' ? { ...s, returnType: 'string' } : s
      ),
      relationships: base.program.relationships
    })

    const conflicts = detectConflicts({
      baseGraph: withPrivate,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: [],
        graph: after
      }
    })
    // Internal change, no external dependents: this is exactly the parallel
    // work the system exists to allow.
    expect(conflicts.filter((c) => c.kind === 'interface')).toHaveLength(0)
  })

  it('does not warn when the dependent is inside the same module', () => {
    const intra = graph({
      modules: [module('authentication', 'src/auth', ['src/auth/index.ts'])],
      symbols: [
        symbol({ id: 'sym:validateToken', name: 'validateToken', returnType: 'boolean' }),
        symbol({ id: 'sym:login', name: 'login' })
      ],
      relationships: [relationship('sym:login', 'sym:validateToken')]
    })
    const after = graph({
      modules: intra.modules,
      symbols: intra.program.symbols.map((s) =>
        s.id === 'sym:validateToken' ? { ...s, returnType: 'Result' } : s
      ),
      relationships: intra.program.relationships
    })

    expect(
      detectConflicts({
        baseGraph: intra,
        incoming: {
          taskId: 't',
          moduleIds: ['authentication'],
          changedPaths: [],
          graph: after
        }
      }).filter((c) => c.kind === 'interface')
    ).toHaveLength(0)
  })
})

describe('data structure conflicts', () => {
  it('reports a changed shared type as a data_structure conflict', () => {
    const before = graph({
      modules: [
        module('types', 'src/types', ['src/types/index.ts']),
        module('payments', 'src/payments', ['src/payments/index.ts'])
      ],
      symbols: [
        symbol({
          id: 'sym:User',
          name: 'User',
          kind: 'interface',
          fields: [
            {
              id: 'f1',
              name: 'id',
              type: 'string',
              accessibility: 'public',
              source: { file: 'src/types/index.ts', start: 0, end: 0, line: 1, endLine: 1, column: 0 },
              version: 1
            }
          ],
          source: { file: 'src/types/index.ts', start: 0, end: 0, line: 1, endLine: 1, column: 0 }
        }),
        symbol({
          id: 'sym:charge',
          name: 'charge',
          source: { file: 'src/payments/index.ts', start: 0, end: 0, line: 1, endLine: 1, column: 0 }
        })
      ],
      relationships: [relationship('sym:charge', 'sym:User')]
    })

    const after = graph({
      modules: before.modules,
      symbols: before.program.symbols.map((s) =>
        s.id === 'sym:User'
          ? {
              ...s,
              fields: [
                {
                  id: 'f1',
                  name: 'userId',
                  type: 'string',
                  accessibility: 'public' as const,
                  source: s.source,
                  version: 2
                }
              ]
            }
          : s
      ),
      relationships: before.program.relationships
    })

    const conflict = detectConflicts({
      baseGraph: before,
      incoming: { taskId: 't', moduleIds: ['types'], changedPaths: [], graph: after }
    }).find((c) => c.kind === 'data_structure')

    expect(conflict).toBeDefined()
    expect(conflict!.explanation).toContain('id: string')
    expect(conflict!.explanation).toContain('userId: string')
    expect(conflict!.affectedModuleIds).toEqual(['payments'])
  })
})

describe('contract conflicts', () => {
  it('reports a changed guarantee as suspected, never proven', () => {
    const base = authAndPayments('boolean')
    const withContract = graph({
      modules: base.modules,
      symbols: base.program.symbols,
      relationships: base.program.relationships,
      contracts: [
        {
          id: 'c1',
          moduleId: 'authentication',
          symbolId: 'sym:validateToken',
          category: 'postcondition',
          description: 'returns false for an expired token',
          provenance: 'inferred',
          verification: 'unverified',
          verificationNote: '',
          evidence: [],
          version: 1
        }
      ]
    })
    const after = graph({
      modules: base.modules,
      symbols: base.program.symbols,
      relationships: base.program.relationships,
      contracts: [
        {
          ...withContract.program.contracts[0],
          description: 'throws for an expired token',
          version: 2
        }
      ]
    })

    const conflict = detectConflicts({
      baseGraph: withContract,
      incoming: {
        taskId: 't',
        moduleIds: ['authentication'],
        changedPaths: [],
        graph: after
      }
    }).find((c) => c.kind === 'contract')

    expect(conflict).toBeDefined()
    expect(conflict!.severity).toBe('warning')
    // The wording must not overstate what we know.
    expect(conflict!.explanation).toContain('suspected')
    expect(conflict!.explanation).toContain('unverified')
  })
})

describe('file and configuration conflicts', () => {
  const base = authAndPayments('boolean')

  it('reports paths Git could not merge as blocking facts', () => {
    const conflicts = detectConflicts({
      baseGraph: base,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: ['src/auth/index.ts'],
        graph: null
      },
      gitConflictPaths: ['src/auth/index.ts']
    })
    const fileConflict = conflicts.find((c) => c.kind === 'file')
    expect(fileConflict?.severity).toBe('blocking')
    expect(fileConflict?.paths).toEqual(['src/auth/index.ts'])
  })

  it('warns when another in-flight task touches the same files', () => {
    const conflicts = detectConflicts({
      baseGraph: base,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: ['src/auth/index.ts'],
        graph: null
      },
      others: [
        {
          taskId: 'task-b',
          moduleIds: ['authentication'],
          changedPaths: ['src/auth/index.ts'],
          graph: null
        }
      ]
    })
    const overlap = conflicts.find((c) => c.withTaskIds.includes('task-b'))
    expect(overlap?.severity).toBe('warning')
  })

  it('escalates shared configuration when two tasks both touch it', () => {
    const alone = detectConflicts({
      baseGraph: base,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: ['package.json'],
        graph: null
      }
    }).find((c) => c.kind === 'shared_config')
    expect(alone?.severity).toBe('warning')

    const contended = detectConflicts({
      baseGraph: base,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: ['package.json'],
        graph: null
      },
      others: [
        {
          taskId: 'task-b',
          moduleIds: ['payments'],
          changedPaths: ['package.json'],
          graph: null
        }
      ]
    }).find((c) => c.kind === 'shared_config')
    // Two tasks editing the manifest collide even though their modules do not.
    expect(contended?.severity).toBe('blocking')
    expect(contended?.withTaskIds).toContain('task-b')
  })

  it('recognises manifests, lockfiles and CI config as shared', () => {
    for (const path of [
      'package.json',
      'tsconfig.json',
      'tsconfig.node.json',
      'pnpm-lock.yaml',
      'Cargo.toml',
      'go.mod',
      '.github/workflows/ci.yml',
      'Dockerfile'
    ]) {
      expect(isSharedConfigPath(path), path).toBe(true)
    }
    for (const path of ['src/auth/index.ts', 'src/payments/charge.ts']) {
      expect(isSharedConfigPath(path), path).toBe(false)
    }
  })

  it('sorts blocking conflicts ahead of warnings', () => {
    const conflicts = detectConflicts({
      baseGraph: base,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: ['package.json', 'src/auth/index.ts'],
        graph: null
      },
      gitConflictPaths: ['src/auth/index.ts']
    })
    expect(conflicts[0].severity).toBe('blocking')
  })

  it('finds nothing to report for genuinely independent work', () => {
    const conflicts = detectConflicts({
      baseGraph: base,
      incoming: {
        taskId: 'task-a',
        moduleIds: ['authentication'],
        changedPaths: ['src/auth/oauth.ts'],
        graph: null
      },
      others: [
        {
          taskId: 'task-b',
          moduleIds: ['payments'],
          changedPaths: ['src/payments/charge.ts'],
          graph: null
        }
      ]
    })
    expect(conflicts).toHaveLength(0)
    expect(formatConflictReport(conflicts)).toBe('No conflicts detected.')
  })
})

describe('write scope', () => {
  const base = authAndPayments('boolean')

  it('accepts new files inside the module directory', () => {
    const check = checkScope(base, ['authentication'], [
      'src/auth/index.ts',
      'src/auth/oauth.ts'
    ])
    expect(check.ok).toBe(true)
    expect(check.inScope).toHaveLength(2)
    expect(check.violations).toHaveLength(0)
  })

  it('flags a write into another module', () => {
    const check = checkScope(base, ['authentication'], [
      'src/auth/index.ts',
      'src/payments/index.ts'
    ])
    expect(check.ok).toBe(false)
    expect(check.violations).toEqual([
      { path: 'src/payments/index.ts', ownerModuleId: 'payments', reason: 'other_module' }
    ])
    expect(describeScopeCheck(check, base)).toContain('Payments')
  })

  it('flags a file no module owns', () => {
    const check = checkScope(base, ['authentication'], ['scripts/tool.ts'])
    expect(check.violations[0].reason).toBe('unowned')
    expect(describeScopeCheck(check, base)).toContain('no module')
  })

  it('separates shared configuration from trespass', () => {
    const check = checkScope(base, ['authentication'], [
      'src/auth/index.ts',
      'package.json'
    ])
    // Reported, but not a scope failure: a task may legitimately need a
    // dependency. The risk is collision, not trespass.
    expect(check.ok).toBe(true)
    expect(check.sharedConfig).toEqual(['package.json'])
    expect(check.violations[0].reason).toBe('shared_config')
  })

  it('attributes a path to the most specific module', () => {
    const nested = graph({
      modules: [
        module('src', 'src', []),
        module('auth', 'src/auth', [])
      ],
      symbols: []
    })
    expect(ownerOf(nested, 'src/auth/index.ts')).toBe('auth')
    expect(ownerOf(nested, 'src/main.ts')).toBe('src')
    expect(ownerOf(nested, 'docs/readme.md')).toBeNull()
  })
})
