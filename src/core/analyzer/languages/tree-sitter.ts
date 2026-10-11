import { Parser, Language, type Node, type Tree } from 'web-tree-sitter'
import { getWasmPath } from 'tree-sitter-wasm'
import type { SourceSymbol, SymbolKind } from '../../../shared/types/architecture'
import type { DiscoveredFile } from '../scan'
import type { AnalyzerContext, FileAnalysis, ImportRecord } from './types'

export type { Node }
type Grammar = 'python' | 'java' | 'c' | 'cpp' | 'typescript' | 'tsx' | 'javascript'
let initialization: Promise<void> | undefined
const languages = new Map<string, Promise<Language>>()

async function parserFor(grammar: Grammar): Promise<Parser> {
  initialization ??= Parser.init()
  await initialization
  let language = languages.get(grammar)
  if (!language) {
    language = Language.load(getWasmPath(grammar))
    languages.set(grammar, language)
  }
  const parser = new Parser()
  parser.setLanguage(await language)
  return parser
}

export function* walk(node: Node): Generator<Node> {
  yield node
  for (const child of node.children) yield* walk(child)
}

export function symbol(node: Node, file: string, name: string, kind: SymbolKind, exported: boolean): SourceSymbol {
  const body = node.childForFieldName('body')
  const signature = node.text.slice(0, body ? body.startIndex - node.startIndex : undefined)
    .replace(/\s+/g, ' ').trim()
  return { name, kind, file, line: node.startPosition.row + 1, exported,
    isDefaultExport: false, signature: signature.slice(0, 120),
    loc: node.endPosition.row - node.startPosition.row + 1 }
}

export function importRecord(specifier: string, node: Node, symbols: string[], resolvedPath: string | null,
  external = false, packageName: string | null = null): ImportRecord {
  return { specifier, resolvedPath, external, packageName, symbols,
    line: node.startPosition.row + 1, typeOnly: false, style: 'static' }
}

export interface ParsedFile { file: DiscoveredFile; root: Node; analysis: FileAnalysis }

/** Parse using bundled WASM grammars: no language runtime, compiler, or project execution. */
export async function analyzeSyntax(files: DiscoveredFile[], context: AnalyzerContext,
  grammar: (file: DiscoveredFile) => Grammar,
  collect: (parsed: ParsedFile[]) => void | Promise<void>): Promise<FileAnalysis[]> {
  const parsers = new Map<string, Parser>()
  const trees: Tree[] = []
  const parsed: ParsedFile[] = []
  const results: FileAnalysis[] = []
  try {
    for (const file of files) {
      const analysis: FileAnalysis = { path: file.path, language: file.language, loc: file.loc,
        symbols: [], exportedNames: [], imports: [], problems: [] }
      results.push(analysis)
      const id = grammar(file)
      let parser = parsers.get(id)
      if (!parser) { parser = await parserFor(id); parsers.set(id, parser) }
      const tree = parser.parse(file.content)
      if (!tree) { analysis.problems.push(`Could not parse ${file.path}.`); continue }
      trees.push(tree)
      parsed.push({ file, root: tree.rootNode, analysis })
      if (tree.rootNode.hasError) {
        for (const node of walk(tree.rootNode)) {
          if (node.type === 'ERROR' || node.isMissing) {
            analysis.problems.push(`${file.path}:${node.startPosition.row + 1}: syntax error (${node.type}); analysis may be incomplete.`)
            if (analysis.problems.length >= 10) break
          }
        }
      }
    }
    await collect(parsed)
    results.forEach((result, i) => context.onProgress?.(i + 1, files.length, result.path))
    return results
  } finally {
    trees.forEach((tree) => tree.delete())
    parsers.forEach((parser) => parser.delete())
  }
}

export function unresolved(analysis: FileAnalysis, node: Node, specifier: string, reason = 'does not resolve to an analyzed file'): void {
  analysis.problems.push(`${analysis.path}:${node.startPosition.row + 1} imports "${specifier}", which ${reason}.`)
}
