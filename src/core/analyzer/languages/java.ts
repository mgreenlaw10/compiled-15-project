import type { DiscoveredFile } from '../scan'
import type { AnalyzerContext, FileAnalysis, LanguageAnalyzer } from './types'
import { analyzeSyntax, importRecord, symbol, unresolved, walk, type Node } from './tree-sitter'

const declarations = new Map<string, 'class' | 'interface' | 'enum'>([
  ['class_declaration', 'class'], ['record_declaration', 'class'],
  ['interface_declaration', 'interface'], ['annotation_type_declaration', 'interface'], ['enum_declaration', 'enum']
])

export class JavaAnalyzer implements LanguageAnalyzer {
  readonly id = 'java'
  readonly displayName = 'Java'
  readonly extensions = ['.java'] as const

  async analyze(files: DiscoveredFile[], context: AnalyzerContext): Promise<FileAnalysis[]> {
    return analyzeSyntax(files, context, () => 'java', (parsed) => {
      const types = new Map<string, Set<string>>()
      const packages = new Map<string, Set<string>>()
      const packageNames = new Map<string, string>()
      for (const { file, root, analysis } of parsed) {
        const packageNode = root.namedChildren.find((n) => n.type === 'package_declaration')
        const pkg = packageNode?.namedChildren.find((n) => ['identifier', 'scoped_identifier'].includes(n.type))?.text ?? ''
        packageNames.set(file.path, pkg)
        const packageFiles = packages.get(pkg) ?? new Set<string>()
        packageFiles.add(file.path)
        packages.set(pkg, packageFiles)
        const collect = (node: Node, prefix: string, parentPublic: boolean): void => {
          const kind = declarations.get(node.type)
          const name = node.childForFieldName('name')?.text
          if (!kind || !name) return
          const qualified = prefix ? `${prefix}.${name}` : name
          const paths = types.get(qualified) ?? new Set<string>()
          paths.add(file.path)
          types.set(qualified, paths)
          const exported = parentPublic && /\bpublic\b/.test(node.namedChildren.find((n) => n.type === 'modifiers')?.text ?? '')
          analysis.symbols.push(symbol(node, file.path, name, kind, exported))
          for (const child of node.childForFieldName('body')?.namedChildren ?? []) collect(child, qualified, exported)
        }
        root.namedChildren.forEach((node) => collect(node, pkg, true))
        analysis.exportedNames = analysis.symbols.filter((s) => s.exported).map((s) => s.name).sort()
      }
      for (const { file, root, analysis } of parsed) {
        for (const node of root.namedChildren.filter((n) => n.type === 'import_declaration')) {
          const name = node.namedChildren.find((n) => ['identifier', 'scoped_identifier'].includes(n.type))?.text
          if (!name) continue
          const isStatic = node.children.some((n) => n.type === 'static')
          const wildcard = node.namedChildren.some((n) => n.type === 'asterisk')
          const specifier = name + (wildcard ? '.*' : '')
          const symbols = [wildcard ? '*' : name.split('.').at(-1)!]
          let target = isStatic && !wildcard ? name.slice(0, name.lastIndexOf('.')) : name
          let candidates: Set<string> | undefined
          if (wildcard && !isStatic) candidates = packages.get(target)
          else {
            // A nested type or static member is owned by its declaring source file.
            while (target && !types.has(target)) target = target.includes('.') ? target.slice(0, target.lastIndexOf('.')) : ''
            candidates = types.get(target)
          }
          const pkg = packageNames.get(file.path) ?? ''
          const local = [...packages.keys()].some((p) => p && (name === p || name.startsWith(`${p}.`))) ||
            (!!pkg && name.startsWith(`${pkg}.`))
          if (candidates?.size && ((wildcard && !isStatic) || candidates.size === 1)) {
            for (const resolved of candidates) analysis.imports.push(importRecord(specifier, node, symbols, resolved))
          } else {
            const external = !local && !candidates?.size
            analysis.imports.push(importRecord(specifier, node, symbols, null, external,
              external ? name.split('.').slice(0, -1).join('.') || name : null))
            if (!external) unresolved(analysis, node, specifier, candidates?.size ? 'matches multiple declarations' : undefined)
          }
        }
        // Java permits references to types in the same package without imports.
        // Resolve only names declared in this project; no classpath inference.
        const pkg = packageNames.get(file.path) ?? ''
        const typeParameters = new Set([...walk(root)]
          .filter((n) => n.type === 'type_parameter')
          .map((n) => n.namedChildren.find((c) => c.type === 'type_identifier')?.text))
        const importedNames = new Set(analysis.imports.flatMap((i) => i.symbols).filter((name) => name !== '*'))
        const declaredNames = new Set(analysis.symbols.map((s) => s.name))
        for (const node of walk(root)) {
          if (!['type_identifier', 'scoped_type_identifier'].includes(node.type)) continue
          if (node.parent?.type === 'scoped_type_identifier' || typeParameters.has(node.text)) continue
          if (importedNames.has(node.text.split('.')[0]) || declaredNames.has(node.text.split('.')[0])) continue
          const qualified = node.text.includes('.') ? node.text : pkg ? `${pkg}.${node.text}` : node.text
          const candidates = types.get(qualified)
          if (!candidates) continue
          if (candidates.size > 1) {
            unresolved(analysis, node, qualified, 'matches multiple declarations')
            continue
          }
          const target = [...candidates][0]
          if (target !== file.path && !analysis.imports.some((i) => i.resolvedPath === target)) {
            const record = importRecord(qualified, node, [node.text], target)
            record.typeOnly = true
            analysis.imports.push(record)
          }
        }
      }
    })
  }
}
