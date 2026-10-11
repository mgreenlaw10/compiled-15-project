import type { ArchitectureGraph, ModuleNode } from '../types/architecture'
import type { ProgramSymbol } from '../types/program'
import { languageOf } from '../languages'

export type DraftCategory = 'interface' | 'data' | 'implementation'

/** A desired element has no fabricated source declaration or required signature. */
export function createDraftSymbol(graph: ArchitectureGraph, module: ModuleNode, category: DraftCategory, id: string): ProgramSymbol {
  const files = [...module.files].sort((a, b) => Number(/\.(h|hpp|hh|hxx|pyi|d\.ts)$/.test(a)) - Number(/\.(h|hpp|hh|hxx|pyi|d\.ts)$/.test(b)))
  const language = files[0] ? languageOf(files[0]).replace(/-(react|declaration)$/, '') :
    Object.entries(graph.analysis.languages).sort((a, b) => b[1] - a[1])[0]?.[0].replace(/-(react|declaration)$/, '') ?? 'typescript'
  const extension = language === 'java' ? 'java' : language === 'python' ? 'py' : language === 'c' ? 'c' : language === 'cpp' ? 'cpp' : language === 'javascript' ? 'js' : 'ts'
  const file = files[0] ?? `${module.directory ? module.directory + '/' : ''}${extension === 'java' ? 'NewComponent' : 'index'}.${extension}`
  const structure = graph.program.symbols.find((s) => s.source.file === file && s.kind === 'class')
  const kind = category === 'data' ? language === 'c' ? 'struct' : 'class' : language === 'java' && structure ? 'method' : 'function'
  const scope = language === 'java' ? structure?.qualifiedName ?? '' : ''
  const base = category === 'data' ? 'NewType' : category === 'implementation' ? language === 'python' ? '_newImplementation' : 'newImplementation' : 'newFunction'
  let name = base
  for (let n = 2; graph.program.symbols.some((s) => s.name === name && s.source.file === file); n++) name = `${base}${n}`
  const internal = category === 'implementation'
  const source = { file, start: 0, end: 0, line: 1, endLine: 1, column: 1 }
  return { id, name, qualifiedName: scope ? `${scope}.${name}` : name, scope, kind, language,
    accessibility: internal ? ['c', 'cpp', 'typescript', 'javascript'].includes(language) ? 'internal' : 'private' : 'public',
    linkage: ['c', 'cpp'].includes(language) ? internal ? 'internal' : 'external' : 'none', publiclyAccessible: !internal,
    signature: '', parameters: [], returnType: '', exceptions: [], fields: [], bases: [], description: '', descriptionOrigin: 'user',
    source, nameSource: source, signatureSource: source, sourceText: '', definition: false, version: 1 }
}
