import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { DiscoveredFile } from '../scan'
import type { AnalyzerContext, FileAnalysis, LanguageAnalyzer } from './types'
import { analyzeSyntax, importRecord, symbol, unresolved, walk, type Node } from './tree-sitter'

interface IncludePaths { quote: string[]; normal: string[] }

/** Read compiler search paths without invoking a compiler or executing commands. */
async function includePaths(context: AnalyzerContext): Promise<{ paths: Map<string, IncludePaths>; ambiguous: Set<string>; problems: string[] }> {
  const paths = new Map<string, IncludePaths>()
  const ambiguous = new Set<string>()
  const problems: string[] = []
  let text: string
  try { text = await fs.readFile(path.join(context.projectRoot, 'compile_commands.json'), 'utf8') }
  catch { return { paths, ambiguous, problems } }
  try {
    const entries: unknown = JSON.parse(text)
    if (!Array.isArray(entries)) throw new Error('expected an array')
    for (const entry of entries as { file?: string; directory?: string; arguments?: string[]; command?: string }[]) {
      if (typeof entry.file !== 'string') continue
      const directory = path.resolve(context.projectRoot, entry.directory ?? '.')
      const key = path.relative(context.projectRoot, path.resolve(directory, entry.file)).replace(/\\/g, '/')
      const args = Array.isArray(entry.arguments) ? entry.arguments :
        (entry.command?.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((a) => a.replace(/["']/g, ''))
      const include: IncludePaths = { quote: [], normal: [] }
      for (let i = 0; i < args.length; i++) {
        const flag = args[i]
        const match = /^(?:-I|\/I|-iquote|-isystem)(.*)$/.exec(flag)
        if (!match) continue
        const value = match[1] || args[++i]
        if (!value) continue
        const rel = path.relative(context.projectRoot, path.resolve(directory, value)).replace(/\\/g, '/')
        if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) continue
        const dirs = flag.startsWith('-iquote') ? include.quote : include.normal
        dirs.push(rel)
      }
      // Conflicting configurations must not silently choose a dependency.
      const previous = paths.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(include)) {
        problems.push(`Multiple compiler include configurations for ${key}; include resolution may be incomplete.`)
        ambiguous.add(key)
        paths.delete(key)
      } else if (!ambiguous.has(key)) paths.set(key, include)
    }
  } catch (error) {
    problems.push(`Could not read compile_commands.json: ${(error as Error).message}; using conventional include roots.`)
  }
  return { paths, ambiguous, problems }
}

function declaratorName(node: Node | null): string | null {
  if (!node) return null
  if (['identifier', 'field_identifier', 'qualified_identifier', 'operator_name', 'destructor_name', 'type_identifier'].includes(node.type)) return node.text
  return declaratorName(node.childForFieldName('declarator'))
}

function isFunctionDeclaration(node: Node): boolean {
  let current: Node | null = node
  while (current) {
    if (current.type === 'function_declarator') {
      const inner = current.childForFieldName('declarator')
      return !!inner && ['identifier', 'qualified_identifier', 'operator_name', 'destructor_name'].includes(inner.type)
    }
    current = current.childForFieldName('declarator')
  }
  return false
}

export class CppAnalyzer implements LanguageAnalyzer {
  readonly id = 'c-cpp'
  readonly displayName = 'C / C++'
  readonly extensions = ['.c', '.h', '.cc', '.cpp', '.cxx', '.c++', '.hh', '.hpp', '.hxx', '.h++', '.ipp', '.tpp'] as const

  async analyze(files: DiscoveredFile[], context: AnalyzerContext): Promise<FileAnalysis[]> {
    const known = new Set(files.map((f) => f.path))
    const compiler = await includePaths(context)
    return analyzeSyntax(files, context, (file) => file.path.toLowerCase().endsWith('.c') ? 'c' : 'cpp', (parsed) => {
      for (const { file, root, analysis } of parsed) {
        analysis.problems.push(...compiler.problems)
        const collect = (node: Node): void => {
          if (node.type === 'function_definition') {
            const name = declaratorName(node.childForFieldName('declarator'))
            if (name) analysis.symbols.push(symbol(node, file.path, name, 'function', !/\bstatic\b/.test(node.namedChildren.find((n) => n.type === 'storage_class_specifier')?.text ?? '')))
            return
          }
          if (['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(node.type)) {
            const name = node.childForFieldName('name')?.text
            if (name) analysis.symbols.push(symbol(node, file.path, name, node.type === 'enum_specifier' ? 'enum' : 'class', true))
            return
          }
          if (['type_definition', 'alias_declaration'].includes(node.type)) {
            const name = node.childForFieldName('name')?.text ?? declaratorName(node.childForFieldName('declarator'))
            if (name) analysis.symbols.push(symbol(node, file.path, name, 'type', true))
            return
          }
          if (node.type === 'declaration') {
            for (const decl of node.childrenForFieldName('declarator')) {
              const name = declaratorName(decl)
              if (!name) continue
              const functionLike = isFunctionDeclaration(decl)
              const exported = !node.namedChildren.some((n) => n.type === 'storage_class_specifier' && n.text === 'static')
              if (functionLike || exported) analysis.symbols.push(symbol(node, file.path, name, functionLike ? 'function' : 'variable', exported))
            }
          }
          for (const child of node.namedChildren) collect(child)
        }
        collect(root)
        analysis.exportedNames = [...new Set(analysis.symbols.filter((s) => s.exported).map((s) => s.name))].sort()
        for (const node of walk(root)) {
          if (node.type !== 'preproc_include') continue
          const include = node.childForFieldName('path')
          if (!include) continue
          if (!['string_literal', 'system_lib_string'].includes(include.type)) {
            analysis.imports.push(importRecord(include.text, node, ['*'], null))
            unresolved(analysis, node, include.text, 'uses a macro that cannot be statically resolved')
            continue
          }
          const specifier = include.text.slice(1, -1)
          const quoted = include.type === 'string_literal'
          const configured = compiler.paths.get(file.path)
          let resolved: string | null = null
          let ambiguous = false
          const local = quoted ? path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier)) : null
          if (local && known.has(local)) resolved = local
          if (!resolved && compiler.ambiguous.has(file.path)) {
            ambiguous = true
          } else if (!resolved && configured) {
            const dirs = [...(quoted ? configured.quote : []), ...configured.normal]
            resolved = dirs.map((dir) => path.posix.normalize(path.posix.join(dir, specifier)))
              .find((candidate) => known.has(candidate)) ?? null
          } else if (!resolved) {
            const candidates = new Set(['', 'include', 'src', 'lib'].map((dir) => path.posix.normalize(path.posix.join(dir, specifier)))
              .filter((candidate) => known.has(candidate)))
            if (candidates.size === 1) resolved = [...candidates][0]
            ambiguous = candidates.size > 1
          }
          const external = !resolved && !quoted && !ambiguous
          analysis.imports.push(importRecord(specifier, node, ['*'], resolved, external, external ? specifier : null))
          if (!resolved && !external) unresolved(analysis, node, specifier, ambiguous ? 'is ambiguous across include roots' : undefined)
        }
      }
    })
  }
}
