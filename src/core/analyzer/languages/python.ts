import path from 'node:path'
import type { DiscoveredFile } from '../scan'
import type { AnalyzerContext, FileAnalysis, LanguageAnalyzer } from './types'
import { analyzeSyntax, importRecord, symbol, unresolved, walk, type Node } from './tree-sitter'

function literalExportName(node: Node): string | null {
  if (node.type !== 'string') return null
  const match = /^(?:r|u)?('''|"""|'|")([\s\S]*)\1$/i.exec(node.text)
  // Escaped/interpolated names need evaluation; do not publish an incorrect name.
  return match && !match[2].includes('\\') ? match[2] : null
}

export class PythonAnalyzer implements LanguageAnalyzer {
  readonly id = 'python'
  readonly displayName = 'Python'
  readonly extensions = ['.py', '.pyi'] as const

  async analyze(files: DiscoveredFile[], context: AnalyzerContext): Promise<FileAnalysis[]> {
    const known = new Set(files.map((f) => f.path))
    const roots = ['', 'src', 'lib'].filter((root) => !root || files.some((f) => f.path.startsWith(`${root}/`)))
    const moduleAt = (base: string): string | null => {
      if (base.startsWith('../') || base === '..' || path.posix.isAbsolute(base)) return null
      return [`${base}/__init__.py`, `${base}.py`, `${base}/__init__.pyi`, `${base}.pyi`]
        .find((candidate) => known.has(candidate)) ?? null
    }
    const localNames = new Set<string>()
    for (const file of files) for (const root of roots) {
      if (root && !file.path.startsWith(`${root}/`)) continue
      const rel = root ? file.path.slice(root.length + 1) : file.path
      localNames.add(rel.split('/')[0].replace(/\.pyi?$/, ''))
    }
    return analyzeSyntax(files, context, () => 'python', (parsed) => {
      for (const { file, root, analysis } of parsed) {
        let explicitExports: Set<string> | null = null
        for (const statement of root.namedChildren) {
          const node = statement.type === 'decorated_definition'
            ? statement.childForFieldName('definition') ?? statement : statement
          const name = node.childForFieldName('name')?.text
          if (name && (node.type === 'class_definition' || node.type === 'function_definition')) {
            analysis.symbols.push(symbol(node, file.path, name,
              node.type === 'class_definition' ? 'class' : 'function', !name.startsWith('_')))
          }
          if (node.type === 'expression_statement') {
            const assignment = node.firstNamedChild
            const left = assignment?.childForFieldName('left')
            const right = assignment?.childForFieldName('right')
            if (assignment?.type === 'assignment' && left?.type === 'identifier' && right) {
              if (left.text === '__all__') {
                const names = right.namedChildren.map(literalExportName)
                if (['list', 'tuple', 'set'].includes(right.type) && names.every((name) => name !== null)) {
                  explicitExports = new Set(names as string[])
                } else analysis.problems.push(`${file.path}:${node.startPosition.row + 1}: dynamic __all__ cannot be statically determined.`)
              } else {
                analysis.symbols.push(symbol(node, file.path, left.text, 'variable', !left.text.startsWith('_')))
              }
            }
          }
        }
        if (explicitExports) analysis.symbols.forEach((s) => { s.exported = explicitExports!.has(s.name) })
        analysis.exportedNames = explicitExports ? [...explicitExports].sort()
          : analysis.symbols.filter((s) => s.exported).map((s) => s.name).sort()

        const record = (node: Node, specifier: string, names: string[], child?: string): void => {
          const dots = specifier.match(/^\.+/)?.[0].length ?? 0
          const module = specifier.slice(dots).replace(/\./g, '/')
          let bases: string[]
          if (dots) {
            const parts = path.posix.dirname(file.path).split('/').filter((p) => p !== '.')
            if (dots > parts.length) {
              analysis.imports.push(importRecord(specifier, node, names, null))
              unresolved(analysis, node, specifier, 'goes beyond the top-level package')
              return
            }
            bases = [path.posix.join(parts.slice(0, parts.length - dots + 1).join('/'), module)]
          } else bases = roots.map((r) => path.posix.join(r, module))
          const candidates = new Set<string>()
          for (const base of bases) {
            const target = (child && child !== '*' ? moduleAt(`${base}/${child}`) : null) ?? moduleAt(base)
            if (target) candidates.add(target)
          }
          const resolved = candidates.size === 1 ? [...candidates][0] : null
          const external = !dots && candidates.size === 0 && !localNames.has(specifier.split('.')[0])
          analysis.imports.push(importRecord(specifier, node, names, resolved, external,
            external ? specifier.split('.')[0] : null))
          if (!resolved && !external) unresolved(analysis, node, specifier,
            candidates.size > 1 ? 'is ambiguous across source roots' : undefined)
        }
        for (const node of walk(root)) {
          if (node.type === 'import_statement') {
            for (const imported of node.childrenForFieldName('name')) {
              const name = imported.type === 'aliased_import' ? imported.childForFieldName('name')!.text : imported.text
              record(node, name, ['*'])
            }
          } else if (node.type === 'import_from_statement') {
            const module = node.childForFieldName('module_name')?.text
            if (!module) continue
            const names = node.childrenForFieldName('name')
            if (!names.length) record(node, module, ['*'])
            for (const imported of names) {
              const name = imported.type === 'aliased_import' ? imported.childForFieldName('name')!.text : imported.text
              record(node, module, [name], name)
            }
          }
        }
      }
    })
  }
}
