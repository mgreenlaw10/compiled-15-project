import type { ArchitectureGraph } from '../../shared/types/architecture'
import type { DiscoveredFile } from '../analyzer/scan'
import { analyzeProgram } from '../analyzer/program-analysis'
import { languageOf, isSourcePath } from '../../shared/languages'
import type { VirtualWorkspace } from './workspace'
import { refreshComponents } from '../../shared/graph/program'
import { createDefaultRegistry, type FileAnalysis } from '../analyzer/languages'
import { parseTsConfigPaths } from '../analyzer/resolve'

/** Refresh source anchors after a planned edit while retaining the desired element identities. */
export async function refreshProgramAnchors(graph: ArchitectureGraph, workspace: VirtualWorkspace): Promise<ArchitectureGraph> {
  const files: DiscoveredFile[] = workspace.listFiles().filter(isSourcePath).map((file) => {
    const content = workspace.read(file)!
    return { path: file, absolutePath: file, content, language: languageOf(file), byteSize: Buffer.byteLength(content), loc: content.split('\n').length }
  })
  const context = { projectRoot: graph.projectRoot, allFiles: files, pathAliases: {} as Record<string, string[]>, baseUrl: '' }
  for (const file of ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json']) {
    const content = workspace.read(file)
    if (!content) continue
    const config = parseTsConfigPaths(content)
    context.pathAliases = config.paths; context.baseUrl = config.baseUrl
    break
  }
  const analyses: FileAnalysis[] = []
  for (const partition of createDefaultRegistry().partition(files)) analyses.push(...await partition.analyzer.analyze(partition.files, context))
  const parsed = await analyzeProgram(files, analyses, context)
  const idMap = new Map<string, string>()
  const fieldMap = new Map<string, string>()
  const symbols = graph.program.symbols.map((symbol) => {
    const currentFile = workspace.currentPathOf(symbol.source.file) ?? symbol.source.file
    let candidates = parsed.symbols.filter((s) => s.source.file === currentFile && s.name === symbol.name && s.kind === symbol.kind && s.scope === symbol.scope)
    if (candidates.length > 1) candidates = candidates.filter((s) => s.parameters.map((p) => p.type).join(',') === symbol.parameters.map((p) => p.type).join(','))
    if (candidates.length !== 1) return symbol
    const actual = candidates[0]
    idMap.set(actual.id, symbol.id)
    actual.fields.forEach((f) => fieldMap.set(f.id, symbol.fields.find((s) => s.name === f.name)?.id ?? f.id))
    const changedSource = actual.sourceText !== symbol.sourceText
    return { ...symbol, ...(changedSource ? { signature: actual.signature, parameters: actual.parameters, returnType: actual.returnType } : {}),
      source: actual.source, nameSource: actual.nameSource, signatureSource: actual.signatureSource, bodySource: actual.bodySource,
      sourceText: actual.sourceText, fields: symbol.fields.map((f) => ({ ...f,
        source: actual.fields.find((a) => a.name === f.name)?.source ?? f.source })) }
  })
  const contractMap = new Map<string, string>()
  const contracts = graph.program.contracts.map((contract) => {
    const symbol = symbols.find((s) => s.id === contract.symbolId)
    if (!symbol) return contract
    const actualSymbol = parsed.symbols.find((s) => s.source.file === symbol.source.file && s.name === symbol.name && s.scope === symbol.scope &&
      s.parameters.map((p) => p.type).join(',') === symbol.parameters.map((p) => p.type).join(','))
    const candidates = parsed.contracts.filter((c) => c.symbolId === actualSymbol?.id &&
      (contract.enforcement ? !!c.enforcement && c.enforcement.kind === contract.enforcement.kind : c.category === contract.category) && c.expression === contract.expression)
    if (candidates.length !== 1) return contract
    contractMap.set(candidates[0].id, contract.id)
    return { ...contract, evidence: candidates[0].evidence, enforcement: candidates[0].enforcement }
  })
  const relationships = parsed.relationships.filter((r) => idMap.has(r.fromSymbolId)).map((r) => ({ ...r,
    fromSymbolId: idMap.get(r.fromSymbolId)!, toSymbolId: r.toSymbolId ? idMap.get(r.toSymbolId) : undefined,
    toFieldId: r.toFieldId ? fieldMap.get(r.toFieldId) : undefined,
    contractId: r.contractId ? contractMap.get(r.contractId) : undefined }))
  return refreshComponents({ ...graph, program: { ...graph.program, symbols, contracts, relationships: [
    ...relationships, ...graph.program.relationships.filter((r) => r.origin === 'user')
  ], fileRelationships: parsed.fileRelationships } })
}
