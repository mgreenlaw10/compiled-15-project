import { describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { analyzeProject } from '../../src/core/analyzer'
import { applyOperation, applyOperations } from '../../src/shared/graph/apply-operation'
import { analyzeImpact } from '../../src/shared/graph/impact'
import { diffArchitectures } from '../../src/shared/graph/diff'
import { planChanges } from '../../src/core/transform/engine'
import { loadSourceFiles } from '../../src/core/pipeline'
import { validateProject } from '../../src/core/output/validate'
import type { GraphOperationBody, GraphOperation } from '../../src/shared/types/operations'
import { operationId } from '../../src/shared/util/id'
import { migrateGraph } from '../../src/shared/graph/program'

const JAVA = path.resolve(__dirname, '../../examples/program-graph/java')
const C = path.resolve(__dirname, '../../examples/program-graph/c')
const op = (body: GraphOperationBody, version: number): GraphOperation => ({ ...body, id: operationId(), actor: 'user', issuedAt: new Date().toISOString(), baseVersion: version })

describe('hierarchical program analysis', () => {
  it('extracts Python instance fields, binds qualified module calls, and keeps nested assertion evidence separate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-python-program-'))
    try {
      await fs.writeFile(path.join(root, 'api.py'), 'def check(value: int) -> int:\n    assert value > 0\n    return value\n')
      await fs.writeFile(path.join(root, 'service.py'), 'import api as provider\nclass Service:\n    def __init__(self, value: int):\n        self.value: int = value\n    def run(self) -> int:\n        def inner():\n            assert False\n        return provider.check(self.value)\n')
      const { graph } = await analyzeProject(root)
      const structure = graph.program.symbols.find((s) => s.name === 'Service')!
      expect(structure.fields).toEqual([expect.objectContaining({ name: 'value', type: 'int' })])
      const api = graph.program.symbols.find((s) => s.name === 'check')!
      expect(graph.program.relationships.some((r) => r.kind === 'call' && r.toSymbolId === api.id && r.source.file === 'service.py' && r.resolution === 'resolved')).toBe(true)
      const run = graph.program.symbols.find((s) => s.name === 'run')!
      expect(graph.program.contracts.some((c) => c.symbolId === run.id && c.expression === 'False')).toBe(false)
      expect(graph.program.contracts.some((c) => c.expression === 'False')).toBe(true)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('extracts C++ access sections and static method visibility', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-cpp-program-'))
    try {
      await fs.writeFile(path.join(root, 'widget.cpp'), 'class Widget { public: static int create(int value) { return value; } private: int hidden; }; struct Data { private: int value; public: int count; };')
      const { graph } = await analyzeProject(root)
      expect(graph.program.symbols.find((s) => s.name === 'create')).toMatchObject({ accessibility: 'public', publiclyAccessible: true })
      expect(graph.program.symbols.find((s) => s.name === 'Data')!.fields).toEqual([
        expect.objectContaining({ name: 'value', accessibility: 'private' }), expect.objectContaining({ name: 'count', accessibility: 'public' })
      ])
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  it('subdivides a Java package, extracts scoped methods/fields/contracts, and resolves exact calls', async () => {
    const { graph } = await analyzeProject(JAVA)
    expect(graph.schemaVersion).toBe(2)
    expect(graph.modules.length).toBeGreaterThanOrEqual(3)
    const withdraw = graph.program.symbols.find((s) => s.qualifiedName === 'bank.Account.withdraw')!
    expect(withdraw).toMatchObject({ kind: 'method', parameters: [{ name: 'amount', type: 'int' }], returnType: 'int', accessibility: 'public' })
    expect(withdraw.source.line).toBe(16)
    const account = graph.program.symbols.find((s) => s.qualifiedName === 'bank.Account')!
    expect(account.fields).toEqual([expect.objectContaining({ name: 'balance', type: 'int', accessibility: 'private' })])
    const call = graph.program.relationships.find((r) => r.kind === 'call' && r.toSymbolId === withdraw.id && r.source.file === 'services/PaymentService.java')!
    expect(call.resolution).toBe('resolved')
    expect(graph.program.symbols.find((s) => s.id === call.fromSymbolId)?.qualifiedName).toBe('bank.PaymentService.pay')
    expect(graph.program.contracts.filter((c) => c.symbolId === withdraw.id).every((c) => c.provenance === 'explicit' && c.verification === 'unverified')).toBe(true)
    expect(graph.program.relationships.some((r) => r.kind === 'contract' && r.source.file === 'services/PaymentService.java' && r.resolution === 'resolved')).toBe(true)
    expect(graph.edges.some((e) => e.kind === 'calls' && e.evidence.some((r) => r.toSymbolId === withdraw.id))).toBe(true)
  })

  it('groups C headers with their implementation across folders while keeping payment callers separate', async () => {
    const { graph } = await analyzeProject(C)
    const account = graph.modules.find((m) => m.files.includes('implementation/account.c'))!
    expect(account.files).toContain('include/account.h')
    expect(account.files).not.toContain('payments/payment.c')
    const data = graph.program.symbols.find((s) => s.name === 'Account' && s.kind === 'struct')!
    expect(data.fields[0]).toMatchObject({ name: 'balance', type: 'int' })
    const withdraw = graph.program.symbols.find((s) => s.name === 'account_withdraw' && s.definition)!
    expect(withdraw.parameters).toEqual([expect.objectContaining({ name: 'account', type: 'Account*' }), expect.objectContaining({ name: 'amount', type: 'int' })])
    const calls = graph.program.relationships.filter((r) => r.kind === 'call' && r.toSymbolId === withdraw.id)
    expect(calls.some((r) => r.source.file === 'payments/payment.c')).toBe(true)
    expect(graph.program.relationships.some((r) => r.kind === 'field_write' && r.toFieldId === data.fields[0].id)).toBe(true)
    expect(graph.program.fileRelationships.some((r) => r.kind === 'include')).toBe(true)
    expect(account.components.interface.functionIds).toContain(withdraw.id)
  })

  it('preserves overloaded identities and distinguishes ambiguous calls', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-overloads-'))
    try {
      const file = path.join(root, 'Example.java')
      const text = 'public class Example { public int value(int x){return x;} public int value(String x){return x.length();} public int run(){return value(1);} }'
      await fs.writeFile(file, text)
      const first = (await analyzeProject(root)).graph
      const methods = first.program.symbols.filter((s) => s.name === 'value')
      expect(methods).toHaveLength(2)
      expect(methods[0].id).not.toBe(methods[1].id)
      const target = first.program.relationships.find((r) => r.kind === 'call' && r.targetName === 'Example.value')!
      expect(target.resolution).toBe('resolved')
      expect(first.program.symbols.find((s) => s.id === target.toSymbolId)?.parameters[0].type).toBe('int')
      await fs.writeFile(file, '\n\n' + text)
      expect((await analyzeProject(root)).graph.program.symbols.filter((s) => s.name === 'value').map((s) => s.id)).toEqual(methods.map((s) => s.id))
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})

describe('fine-grained pending edits and impact', () => {
  it('keeps C file movement pending when include rewriting needs language-specific implementation work', async () => {
    const { graph } = await analyzeProject(C)
    const module = graph.modules.find((m) => m.files.includes('implementation/account.c'))!
    const edits = [
      op({ type: 'add_module', module: { id: 'new-account', name: 'New Account', description: '', responsibilities: [], directory: 'new-account', publicInterface: [] } }, graph.version),
      op({ type: 'move_file', file: 'implementation/account.c', fromModuleId: module.id, toModuleId: 'new-account' }, graph.version + 1)
    ]
    const plan = await planChanges(graph, edits, await loadSourceFiles(C))
    expect(plan.changeSet.outcomes[1].status).toBe('unsupported')
    expect(plan.workspace.exists('implementation/account.c')).toBe(true)
    expect(plan.workspace.exists('new-account/account.c')).toBe(false)
    expect(plan.changeSet.changes).toEqual([])
  })
  it('reanchors newly generated Java guards and preserves unrelated desired field changes', async () => {
    const { graph } = await analyzeProject(JAVA)
    const symbol = graph.program.symbols.find((s) => s.name === 'withdraw')!
    const structure = graph.program.symbols.find((s) => s.name === 'Account')!
    const module = graph.modules.find((m) => m.files.includes(symbol.source.file))!
    const contract = { id: 'new-guard', moduleId: module.id, symbolId: symbol.id, category: 'precondition' as const,
      expression: 'amount >= 1', description: 'Require positive amount', provenance: 'user_specified' as const,
      verification: 'unverified' as const, verificationNote: '', evidence: [], version: 1 }
    const operations = [
      op({ type: 'update_symbol', moduleId: module.id, symbolId: structure.id, changes: { fields: [] } }, graph.version),
      op({ type: 'add_contract', moduleId: module.id, contract }, graph.version + 1),
      op({ type: 'modify_contract', moduleId: module.id, contractId: contract.id, changes: { expression: 'amount >= 10' } }, graph.version + 2)
    ]
    const plan = await planChanges(graph, operations, await loadSourceFiles(JAVA))
    expect(plan.changeSet.outcomes.map((o) => o.status)).toEqual(['unsupported', 'applied', 'applied'])
    expect(plan.workspace.read(symbol.source.file)).toContain('if (!(amount >= 10))')
    expect(plan.workspace.read(symbol.source.file)).not.toContain('if (!(amount >= 1))')
    expect(plan.graph.program.contracts.find((c) => c.id === contract.id)?.enforcement?.kind).toBe('guard')
    expect(plan.graph.program.symbols.find((s) => s.id === structure.id)?.fields).toEqual([])
    expect(graph.program.symbols.find((s) => s.id === structure.id)?.fields).toHaveLength(1)
  })
  it('keeps observed signatures separate, identifies callers, and stages a targeted signature change', async () => {
    const { graph } = await analyzeProject(JAVA)
    const symbol = graph.program.symbols.find((s) => s.qualifiedName === 'bank.Account.withdraw')!
    const module = graph.modules.find((m) => m.files.includes(symbol.source.file))!
    const edit = op({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, changes: { parameters: [{ ...symbol.parameters[0], type: 'String' }] }, expectedVersion: 1 }, graph.version)
    const reduced = applyOperation(graph, edit)
    expect(reduced.ok).toBe(true)
    if (!reduced.ok) return
    expect(graph.program.symbols.find((s) => s.id === symbol.id)!.parameters[0].type).toBe('int')
    expect(reduced.graph.program.symbols.find((s) => s.id === symbol.id)!.parameters[0].type).toBe('String')
    expect(analyzeImpact(graph, edit).some((i) => graph.modules.find((m) => m.id === i.moduleId)?.files.includes('services/PaymentService.java'))).toBe(true)
    const planned = await planChanges(graph, [edit], await loadSourceFiles(JAVA))
    expect(planned.changeSet.outcomes[0].status).toBe('partial')
    expect(planned.workspace.read(symbol.source.file)).toContain('withdraw(String amount)')
    expect(planned.changeSet.changes.every((c) => c.path === symbol.source.file)).toBe(true)
    expect(diffArchitectures(graph, reduced.graph).operations.some((o) => o.type === 'update_symbol')).toBe(true)
    expect(applyOperations(graph, [edit]).graph).toEqual(reduced.graph)
  })

  it.each([['Java', JAVA, 'withdraw'], ['C', C, 'account_withdraw']])('changes a %s contract in actual code without changing its signature', async (_language, root, name) => {
    const { graph } = await analyzeProject(root)
    const symbol = graph.program.symbols.find((s) => s.name === name && s.definition)!
    const module = graph.modules.find((m) => m.files.includes(symbol.source.file))!
    const contract = graph.program.contracts.find((c) => c.symbolId === symbol.id && c.enforcement)!
    const edit = op({ type: 'modify_contract', moduleId: module.id, contractId: contract.id, changes: { expression: 'amount > 10', description: 'amount > 10' }, expectedVersion: contract.version }, graph.version)
    const impacts = analyzeImpact(graph, edit)
    expect(impacts.some((i) => i.severity === 'potential' && i.symbolId && graph.program.symbols.find((s) => s.id === i.symbolId)?.name.includes('pay'))).toBe(true)
    const reduced = applyOperation(graph, edit)
    expect(reduced.ok).toBe(true)
    if (!reduced.ok) return
    const desired = reduced.graph.program.contracts.find((c) => c.id === contract.id)!
    expect(desired).toMatchObject({ provenance: 'user_specified', verification: 'unverified', expression: 'amount > 10' })
    expect(contract.expression).toBe('amount > 0')
    const plan = await planChanges(graph, [edit], await loadSourceFiles(root))
    expect(plan.changeSet.outcomes[0].status).toBe('applied')
    expect(plan.workspace.read(symbol.source.file)).toContain('amount > 10')
    expect(plan.workspace.read(symbol.source.file)).toContain(symbol.signature)
    expect(plan.changeSet.breakingChanges.length).toBeGreaterThan(0)
  })

  it('reports explicitly documented contract reliance separately from potential callers', async () => {
    const { graph } = await analyzeProject(JAVA)
    const contract = graph.program.contracts.find((c) => c.category === 'postcondition' && c.symbolId && graph.program.symbols.find((s) => s.id === c.symbolId)?.name === 'withdraw')!
    const edit = { type: 'remove_contract', moduleId: contract.moduleId!, contractId: contract.id } as const
    expect(analyzeImpact(graph, edit).some((i) => i.reason.includes('Explicitly documented'))).toBe(true)
    const plan = await planChanges(graph, [op(edit, graph.version)], await loadSourceFiles(JAVA))
    expect(plan.changeSet.outcomes[0].status).toBe('unsupported')
    expect(plan.changeSet.changes).toEqual([])
    expect(plan.changeSet.breakingChanges.some((c) => c.includes('behavioral'))).toBe(true)
  })

  it('rejects stale edits and version conflicts', async () => {
    const { graph } = await analyzeProject(C)
    const symbol = graph.program.symbols.find((s) => s.name === 'account_withdraw' && s.definition)!
    const module = graph.modules.find((m) => m.files.includes(symbol.source.file))!
    const body = { type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, changes: { name: 'withdraw' }, expectedVersion: 99 } as const
    expect(applyOperation(graph, body).ok).toBe(false)
    const files = await loadSourceFiles(C)
    files.set(symbol.source.file, '// changed\n' + files.get(symbol.source.file))
    const plan = await planChanges(graph, [op({ ...body, expectedVersion: 1 }, graph.version)], files)
    expect(plan.changeSet.outcomes[0].status).toBe('failed')
    expect(plan.changeSet.changes).toEqual([])
  })
})

describe('language validation and migration', () => {
  it.each([['Java', JAVA, 'withdraw'], ['C', C, 'account_withdraw']])('renames a %s API and callers, then reanchors a behavioral edit, and validates generated source', async (language, root, name) => {
    const { graph } = await analyzeProject(root)
    const symbol = graph.program.symbols.find((s) => s.name === name && s.definition)!
    const module = graph.modules.find((m) => m.files.includes(symbol.source.file))!
    const contract = graph.program.contracts.find((c) => c.symbolId === symbol.id && c.enforcement)!
    const rename = op({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, changes: { name: 'withdrawFunds' } }, graph.version)
    const behavior = op({ type: 'modify_contract', moduleId: module.id, contractId: contract.id, changes: { expression: 'amount >= 1' } }, graph.version + 1)
    const plan = await planChanges(graph, [rename, behavior], await loadSourceFiles(root))
    expect(plan.changeSet.outcomes.map((o) => o.status)).toEqual(['applied', 'applied'])
    expect(plan.workspace.read(symbol.source.file)).toContain('amount >= 1')
    const caller = language === 'Java' ? 'services/PaymentService.java' : 'payments/payment.c'
    expect(plan.workspace.read(caller)).toContain('withdrawFunds(')
    if (language === 'C') expect(plan.workspace.read('include/account.h')).toContain('withdrawFunds(')
    const generated = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-generated-'))
    try {
      await fs.cp(root, generated, { recursive: true })
      for (const file of plan.workspace.listFiles()) {
        await fs.mkdir(path.dirname(path.join(generated, file)), { recursive: true })
        await fs.writeFile(path.join(generated, file), plan.workspace.read(file)!)
      }
      const validation = await validateProject(generated)
      expect(validation.checks.filter((c) => c.status === 'failed')).toEqual([])
      const updated = plan.graph.program.symbols.find((s) => s.id === symbol.id)!
      expect(updated.name).toBe('withdrawFunds')
      expect(plan.graph.program.relationships.some((r) => r.kind === 'call' && r.toSymbolId === symbol.id && r.source.file === caller)).toBe(true)
    } finally { await fs.rm(generated, { recursive: true, force: true }) }
  })

  it('uses compiler bindings to preserve TypeScript aliases during a fine-grained rename', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-rename-'))
    try {
      await fs.writeFile(path.join(root, 'api.ts'), 'export function value(x: number): number { return x; }')
      await fs.writeFile(path.join(root, 'caller.ts'), "import { value as local } from './api'; export const result = local(1);")
      const { graph } = await analyzeProject(root)
      const symbol = graph.program.symbols.find((s) => s.name === 'value')!
      const module = graph.modules.find((m) => m.files.includes('api.ts'))!
      const plan = await planChanges(graph, [op({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, changes: { name: 'compute' } }, graph.version)], await loadSourceFiles(root))
      expect(plan.changeSet.outcomes[0].status).toBe('applied')
      expect(plan.workspace.read('api.ts')).toContain('function compute(')
      expect(plan.workspace.read('caller.ts')).toContain('compute as local')
      expect(plan.workspace.read('caller.ts')).toContain('local(1)')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('reports an incompatible generated signature as a compilation failure', async () => {
    const { graph } = await analyzeProject(JAVA)
    const symbol = graph.program.symbols.find((s) => s.name === 'withdraw')!
    const module = graph.modules.find((m) => m.files.includes(symbol.source.file))!
    const plan = await planChanges(graph, [op({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id,
      changes: { parameters: [{ ...symbol.parameters[0], type: 'String' }] } }, graph.version)], await loadSourceFiles(JAVA))
    const generated = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-invalid-'))
    try {
      await fs.cp(JAVA, generated, { recursive: true })
      await fs.writeFile(path.join(generated, symbol.source.file), plan.workspace.read(symbol.source.file)!)
      const validation = await validateProject(generated)
      expect(['failed', 'skipped']).toContain(validation.checks.find((c) => c.name === 'Java compilation')?.status)
      expect(validation.checks.some((c) => c.name.startsWith('Java tests') && c.status === 'passed')).toBe(false)
    } finally { await fs.rm(generated, { recursive: true, force: true }) }
  })

  it.each([['Java', JAVA, 'withdraw'], ['C', C, 'account_withdraw']])('reports %s behavior test failures even when a strengthened contract compiles', async (language, root, name) => {
    const { graph } = await analyzeProject(root)
    const symbol = graph.program.symbols.find((s) => s.name === name && s.definition)!
    const module = graph.modules.find((m) => m.files.includes(symbol.source.file))!
    const contract = graph.program.contracts.find((c) => c.symbolId === symbol.id && c.enforcement)!
    const plan = await planChanges(graph, [op({ type: 'modify_contract', moduleId: module.id, contractId: contract.id,
      changes: { expression: 'amount > 10' } }, graph.version)], await loadSourceFiles(root))
    const generated = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-behavior-'))
    try {
      await fs.cp(root, generated, { recursive: true })
      await fs.writeFile(path.join(generated, symbol.source.file), plan.workspace.read(symbol.source.file)!)
      const result = await validateProject(generated)
      const compile = result.checks.find((c) => c.name === `${language} compilation`)!
      expect(['passed', 'skipped']).toContain(compile.status)
      if (compile.status === 'passed') {
        expect(result.checks.some((c) => c.name.startsWith(language === 'Java' ? 'Java tests' : 'C contract tests') && c.status === 'failed')).toBe(true)
        expect(result.passed).toBe(false)
      }
      expect(result.checks.find((c) => c.name === 'Behavioral contract verification')?.status).toBe('skipped')
    } finally { await fs.rm(generated, { recursive: true, force: true }) }
  })

  it('identifies removed-field consumers and module-wide contracts and retains user reliance as potential intent', async () => {
    const { graph } = await analyzeProject(C)
    const structure = graph.program.symbols.find((s) => s.name === 'Account' && s.kind === 'struct')!
    const module = graph.modules.find((m) => m.files.includes(structure.source.file))!
    const fieldEdit = { type: 'update_symbol', moduleId: module.id, symbolId: structure.id, changes: { fields: [] } } as const
    expect(analyzeImpact(graph, { ...fieldEdit, changes: { fields: [] } }).some((i) => i.reason.includes('edited field balance'))).toBe(true)
    const contract = { id: 'module-contract', moduleId: module.id, category: 'invariant' as const, description: 'Balances are never negative',
      provenance: 'user_specified' as const, verification: 'unverified' as const, verificationNote: '', evidence: [], version: 1 }
    const reduced = applyOperation(graph, { type: 'add_contract', moduleId: module.id, contract })
    expect(reduced.ok).toBe(true)
    if (!reduced.ok) return
    expect(analyzeImpact(reduced.graph, { type: 'remove_contract', moduleId: module.id, contractId: contract.id }).some((i) => i.reason.includes('module-wide'))).toBe(true)
    const consumer = graph.program.symbols.find((s) => s.name === 'payment_charge' && s.definition)!
    const consumerModule = graph.modules.find((m) => m.files.includes(consumer.source.file))!
    const reliance = applyOperation(reduced.graph, { type: 'add_contract_dependency', moduleId: consumerModule.id, fromSymbolId: consumer.id, contractId: contract.id })
    expect(reliance.ok).toBe(true)
    if (!reliance.ok) return
    expect(reliance.graph.program.relationships.find((r) => r.contractId === contract.id)?.resolution).toBe('potential')
    expect(reliance.graph.edges.some((e) => e.kind === 'contracts' && e.evidence.some((r) => r.contractId === contract.id) && !e.verified)).toBe(true)
    const diff = diffArchitectures(graph, reliance.graph)
    expect(diff.operations.some((o) => o.type === 'add_contract_dependency')).toBe(true)
    expect(applyOperations(graph, diff.operations.map((body, index) => op(body, graph.version + index))).failures).toEqual([])
  })
  it.each([['Java', JAVA], ['C', C]])('compiles and runs %s example contract tests when the toolchain is available', async (language, root) => {
    const result = await validateProject(root)
    const compile = result.checks.find((c) => c.name === `${language} compilation`)!
    expect(['passed', 'skipped']).toContain(compile.status)
    if (compile.status === 'passed') {
      expect(result.checks.some((c) => c.name.includes(language === 'Java' ? 'Java tests' : 'C contract tests') && c.status === 'passed')).toBe(true)
    }
    expect(result.checks.find((c) => c.name === 'Behavioral contract verification')?.status).toBe('skipped')
  })

  it('migrates schema-1 graphs without replacing their observed facts or desired descriptions', async () => {
    const { graph } = await analyzeProject(JAVA)
    const old = JSON.parse(JSON.stringify(graph))
    old.schemaVersion = 1
    delete old.program
    old.modules.forEach((m: Record<string, unknown>) => { delete m.components })
    const migrated = migrateGraph(old)
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.modules.map((m) => m.description)).toEqual(graph.modules.map((m) => m.description))
    expect(migrated.program.symbols).toEqual([])
    expect(migrated.modules[0].components.contracts.contractIds).toEqual([])
  })
})
