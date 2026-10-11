import type { GraphOperation } from '../../../shared/types/operations'
import type { ProgramSymbol, SourceRange } from '../../../shared/types/program'
import { analyzeImpact } from '../../../shared/graph/impact'
import { isCallable } from '../../../shared/graph/program'
import { ok, unsupported, failed, type OpContext, type OpResult } from './context'
import { SyntaxKind } from 'ts-morph'
import { createTransformProject, inferQuoteKind } from '../imports'
import { parseTsConfigPaths } from '../../analyzer/resolve'

interface Edit { range: SourceRange; expected: string; replacement: string }
/** Validate every anchor before committing any edit to the virtual workspace. */
function stage(edits: Edit[], op: GraphOperation, ctx: OpContext): OpResult {
  edits = edits.filter((edit) => edit.expected !== edit.replacement)
  if (!edits.length) return unsupported('No source behavior changed. This specification still needs an implementation change.')
  const byFile = new Map<string, Edit[]>()
  for (const edit of edits) byFile.set(edit.range.file, [...(byFile.get(edit.range.file) ?? []), edit])
  const staged = new Map<string, string>()
  for (const [file, changes] of byFile) {
    let text = ctx.workspace.read(file)
    if (text === null) return failed(`Source file is missing: ${file}`)
    const sorted = changes.sort((a, b) => b.range.start - a.range.start)
    let limit = text.length + 1
    for (const edit of sorted) {
      if (edit.range.end > limit) return failed('Overlapping source edits; reanalyze before refactoring.')
      if (text.slice(edit.range.start, edit.range.end) !== edit.expected) return failed(`Source anchor is stale at ${file}:${edit.range.line}; reanalyze before applying this edit.`)
      text = text.slice(0, edit.range.start) + edit.replacement + text.slice(edit.range.end)
      limit = edit.range.start
    }
    staged.set(file, text)
  }
  for (const [file, text] of staged) ctx.workspace.write(file, text, { operationId: op.id, reason: `Apply ${op.type}` })
  const impacts = analyzeImpact(ctx.graph, op)
  return ok(`Planned targeted source changes in ${staged.size} file(s).`, [...staged.keys()], {
    warnings: ['Source relationships were resolved under lexical analysis assumptions; run compilation and tests after writing.'],
    breakingChanges: impacts.map((i) => `${ctx.graph.modules.find((m) => m.id === i.moduleId)?.name ?? i.moduleId}: ${i.reason}`)
  })
}
function sourceEdit(source: SourceRange, replacement: string, ctx: OpContext): Edit {
  return { range: source, expected: ctx.workspace.read(source.file)?.slice(source.start, source.end) ?? '', replacement }
}
function declarationIsCurrent(symbol: ProgramSymbol, ctx: OpContext): boolean {
  return ctx.workspace.read(symbol.source.file)?.slice(symbol.source.start, symbol.source.end) === symbol.sourceText
}
function renderSignature(symbol: ProgramSymbol, desired: ProgramSymbol): string | null {
  if (symbol.signature !== desired.signature) return desired.signature
  const paramStart = symbol.signature.indexOf('(')
  const paramEnd = symbol.signature.lastIndexOf(')')
  if (paramStart < 0 || paramEnd < paramStart) return null
  const python = symbol.language === 'python'
  const ts = ['typescript', 'javascript'].includes(symbol.language)
  const params = desired.parameters.map((p) => python || ts ? `${p.variadic ? python ? '*' : '...' : ''}${p.name}${p.optional && ts ? '?' : ''}${p.type !== 'unknown' ? `: ${p.type}` : ''}${p.defaultValue ? ` = ${p.defaultValue}` : ''}` :
    `${p.type} ${p.variadic ? '...' : p.name}`).join(', ')
  let head = symbol.signature.slice(0, paramStart).replace(new RegExp(`\\b${symbol.name}\\b`), desired.name)
  let tail = symbol.signature.slice(paramEnd + 1)
  if (symbol.returnType !== desired.returnType) {
    if (python) tail = ` -> ${desired.returnType}:`
    else if (ts) tail = `: ${desired.returnType} `
    else if (head.includes(symbol.returnType)) head = head.replace(symbol.returnType, desired.returnType)
    else return null
  }
  return `${head}(${params})${tail}${python ? '' : ' '}`
}
function safeExpression(expression: string, symbol: ProgramSymbol): boolean {
  if (!expression || /[;{}"'`]|\+\+|--|(?:[^=!<>]|^)=(?!=)|\b(new|throw|delete|await|yield)\b|\w\s*\(/.test(expression)) return false
  if (!/^[\w\s.<>=!&|+*/%()?:\[\]-]+$/.test(expression)) return false
  const brackets: string[] = []
  for (const char of expression) {
    if (char === '(' || char === '[') brackets.push(char)
    if (char === ')' || char === ']') {
      if (brackets.pop() !== (char === ')' ? '(' : '[')) return false
    }
  }
  if (brackets.length) return false
  const allowed = new Set([...symbol.parameters.map((p) => p.name), ...symbol.fields.map((f) => f.name), 'this', 'self', 'true', 'false', 'null', 'None', 'and', 'or', 'not'])
  const identifiers = expression.match(/[A-Za-z_]\w*/g) ?? []
  return identifiers.every((name) => allowed.has(name))
}

/** Use the existing TypeScript language service so aliases and re-exports keep their bindings. */
function renameTsSymbol(symbol: ProgramSymbol, name: string, op: GraphOperation, ctx: OpContext): OpResult {
  const project = createTransformProject(inferQuoteKind(symbol.sourceText))
  for (const file of ctx.workspace.listFiles().filter((f) => /\.[cm]?[jt]sx?$/i.test(f))) {
    project.createSourceFile(`/${file}`, ctx.workspace.read(file)!)
  }
  for (const file of ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json']) {
    const content = ctx.workspace.read(file)
    if (!content) continue
    const config = parseTsConfigPaths(content)
    project.compilerOptions.set({ baseUrl: `/${config.baseUrl ?? ''}`, paths: config.paths })
    break
  }
  const source = project.getSourceFile(`/${symbol.source.file}`)
  const identifier = source?.getDescendantsOfKind(SyntaxKind.Identifier).find((node) =>
    node.getStart() === symbol.nameSource.start && node.getText() === symbol.name)
  if (!identifier || !identifier.getSymbol()) return unsupported('The compiler could not bind this declaration; resolve its dependencies before renaming.')
  identifier.rename(name)
  const edits = project.getSourceFiles().flatMap((file) => {
    const path = file.getFilePath().slice(1)
    const before = ctx.workspace.read(path)
    const after = file.getFullText()
    if (before === null || before === after) return []
    return [{ range: { file: path, start: 0, end: before.length, line: 1, endLine: before.split('\n').length, column: 1 }, expected: before, replacement: after }]
  })
  return stage(edits, op, ctx)
}

export function executeProgramOperation(op: GraphOperation, ctx: OpContext): OpResult {
  const fallback = (): OpResult => unsupported('This change requires targeted implementation work. Enable AI generation, or implement it in source and reanalyze; the requested behavior remains pending.')
  if (op.type === 'update_symbol') {
    const symbol = ctx.graph.program.symbols.find((s) => s.id === op.symbolId)
    const desired = ctx.nextGraph.program.symbols.find((s) => s.id === op.symbolId)
    if (!symbol || !desired) return failed('Symbol not found.')
    if (!declarationIsCurrent(symbol, ctx)) return failed('The declaration changed since analysis; reanalyze before refactoring.')
    if (!isCallable(symbol)) return fallback()
    if (op.changes.kind || op.changes.fields || op.changes.accessibility || op.changes.description) return fallback()
    if (op.changes.name && !op.changes.parameters && !op.changes.returnType && !op.changes.signature && ['typescript', 'javascript'].includes(symbol.language)) {
      return renameTsSymbol(symbol, desired.name, op, ctx)
    }
    const edits: Edit[] = []
    const related = ctx.graph.program.symbols.filter((s) => s.id === symbol.id || s.linkage === 'external' && symbol.linkage === 'external' &&
      s.qualifiedName === symbol.qualifiedName && s.parameters.map((p) => p.type).join(',') === symbol.parameters.map((p) => p.type).join(','))
    if (op.changes.parameters || op.changes.returnType || op.changes.signature) {
      if (!isCallable(symbol)) return fallback()
      for (const item of related) {
        if (!declarationIsCurrent(item, ctx)) return failed('A matching declaration is stale; reanalyze before changing this interface.')
        const signature = renderSignature(item, { ...desired, signature: op.changes.signature ?? item.signature })
        if (!signature) return fallback()
        edits.push(sourceEdit(item.signatureSource, signature, ctx))
      }
    } else if (op.changes.name) {
      for (const item of related) edits.push({ range: item.nameSource, expected: item.name, replacement: desired.name })
    }
    if (op.changes.name) {
      const ids = new Set(related.map((s) => s.id))
      const uncertain = ctx.graph.program.relationships.some((r) => r.resolution !== 'resolved' &&
        (r.toSymbolId && ids.has(r.toSymbolId) || !r.toSymbolId && (r.targetName === symbol.name || r.targetName.endsWith(`.${symbol.name}`))))
      if (uncertain) return unsupported('The rename has ambiguous references; use AI or resolve these bindings before applying it.')
      for (const ref of ctx.graph.program.relationships.filter((r) => r.toSymbolId && ids.has(r.toSymbolId) && r.resolution === 'resolved' && r.targetSource)) {
        const caller = ctx.graph.program.symbols.find((s) => s.id === ref.fromSymbolId)
        if (caller && !declarationIsCurrent(caller, ctx)) return failed('A consuming declaration is stale; reanalyze before renaming its references.')
        if (ref.targetSource!.start >= symbol.signatureSource.start && ref.targetSource!.end <= symbol.signatureSource.end && ref.targetSource!.file === symbol.source.file) continue
        const expected = ctx.workspace.read(ref.targetSource!.file)?.slice(ref.targetSource!.start, ref.targetSource!.end)
        if (expected === symbol.name) edits.push({ range: ref.targetSource!, expected, replacement: desired.name })
      }
    }
    if (!edits.length) return fallback()
    const result = stage([...new Map(edits.map((e) => [`${e.range.file}:${e.range.start}:${e.range.end}`, e])).values()], op, ctx)
    const signatureChanges = op.changes.parameters || op.changes.returnType || op.changes.signature
    if (signatureChanges && result.status === 'applied') {
      result.status = 'partial'
      result.message += ' Caller argument/return-value adaptation requires review; affected callers are listed in impact analysis.'
    }
    return result
  }
  if (op.type === 'remove_symbol') {
    const symbol = ctx.graph.program.symbols.find((s) => s.id === op.symbolId)
    if (!symbol || !declarationIsCurrent(symbol, ctx)) return failed('The declaration is missing or stale.')
    if (analyzeImpact(ctx.graph, op).length) return fallback()
    return stage([{ range: symbol.source, expected: symbol.sourceText, replacement: '' }], op, ctx)
  }
  if (['add_contract', 'modify_contract', 'remove_contract'].includes(op.type)) {
    const before = 'contractId' in op ? ctx.graph.program.contracts.find((c) => c.id === op.contractId) : undefined
    const after = op.type === 'add_contract' ? ctx.nextGraph.program.contracts.find((c) => c.id === op.contract.id) :
      'contractId' in op ? ctx.nextGraph.program.contracts.find((c) => c.id === op.contractId) : undefined
    const symbol = ctx.graph.program.symbols.find((s) => s.id === (after?.symbolId ?? before?.symbolId))
    if (!symbol || !isCallable(symbol) || !symbol.bodySource || !declarationIsCurrent(symbol, ctx)) return fallback()
    if (op.type === 'remove_contract') {
      if (!before?.enforcement || !before.evidence[0]) return fallback()
      return stage([sourceEdit(before.evidence[0], '', ctx)], op, ctx)
    }
    if (op.type === 'modify_contract' && before?.expression === after?.expression && before?.description !== after?.description) return fallback()
    if (!after?.expression || (after.category !== 'precondition' && !before?.enforcement) || !safeExpression(after.expression, symbol)) return fallback()
    if (before?.enforcement) {
      if (after.category !== before.category || after.symbolId !== before.symbolId) return fallback()
      return stage([sourceEdit(before.enforcement.expressionSource, after.expression, ctx)], op, ctx)
    }
    if (after.category !== 'precondition') return fallback()
    const body = symbol.bodySource
    const python = symbol.language === 'python'
    const content = ctx.workspace.read(body.file)!
    if (python ? body.line === symbol.source.line : content[body.start] !== '{') return fallback()
    let insertion = body.start + 1
    let replacement: string
    if (python) {
      insertion = body.start
      const indent = ' '.repeat(body.column - 1)
      replacement = `assert ${after.expression}, "Contract precondition"\n${indent}`
    } else if (['c', 'cpp'].includes(symbol.language)) {
      replacement = `\n    assert(${after.expression});`
    } else if (symbol.language === 'java') replacement = `\n    if (!(${after.expression})) { throw new IllegalArgumentException("Contract precondition"); }`
    else replacement = `\n    if (!(${after.expression})) { throw new Error("Contract precondition"); }`
    const edits: Edit[] = [{ range: { ...body, start: insertion, end: insertion }, expected: '', replacement }]
    if (['c', 'cpp'].includes(symbol.language) && !/#\s*include\s*[<"]assert\.h[>"]/.test(content)) {
      edits.push({ range: { ...body, start: 0, end: 0, line: 1 }, expected: '', replacement: '#include <assert.h>\n' })
    }
    const result = stage(edits, op, ctx)
    result.warnings.push('The contract now has a runtime guard; this does not prove postconditions, atomicity, or compatibility. Assertions may be disabled by the language/toolchain.')
    return result
  }
  if (op.type === 'add_contract_dependency') return unsupported('Recorded potential contract reliance in the graph. Establish source evidence and verification before treating it as confirmed.')
  return fallback()
}
