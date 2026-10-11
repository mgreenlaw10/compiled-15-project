/**
 * TypeScript / JavaScript static analysis.
 *
 * Runs ts-morph over an in-memory copy of the project's source files. In-memory
 * is deliberate: analysis must never be influenced by, or write to, the user's
 * working tree, and it makes the pass fast and reproducible. Import resolution
 * is handled by `SpecifierResolver` rather than the TypeScript resolver so the
 * result does not depend on `node_modules` being installed.
 *
 * Everything this file reports is a fact read out of the syntax tree. Nothing
 * here guesses.
 */

import { Project, SyntaxKind, type SourceFile } from 'ts-morph'

import type { SourceSymbol, SymbolKind } from '../../../shared/types/architecture'
import { SpecifierResolver } from '../resolve'
import type { DiscoveredFile } from '../scan'
import type {
  AnalyzerContext,
  FileAnalysis,
  ImportRecord,
  LanguageAnalyzer
} from './index'

const MAX_SIGNATURE_LENGTH = 120

function truncate(text: string, max = MAX_SIGNATURE_LENGTH): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * A capitalised arrow function or function in a `.tsx` file that returns JSX is
 * reported as a `component`, because that distinction is what makes a frontend
 * module graph readable.
 */
function looksLikeComponent(name: string, filePath: string, text: string): boolean {
  if (!/^[A-Z]/.test(name)) return false
  if (!filePath.endsWith('.tsx') && !filePath.endsWith('.jsx')) return false
  return /<[A-Za-z]/.test(text) || /jsx\(|createElement\(/.test(text)
}

function collectSymbols(sf: SourceFile, relPath: string): SourceSymbol[] {
  const symbols: SourceSymbol[] = []

  const push = (
    name: string | undefined,
    kind: SymbolKind,
    node: {
      getStartLineNumber(): number
      getEndLineNumber(): number
      getText(): string
    },
    exported: boolean,
    isDefault: boolean,
    signature: string
  ): void => {
    if (!name) return
    symbols.push({
      name,
      kind,
      file: relPath,
      line: node.getStartLineNumber(),
      exported,
      isDefaultExport: isDefault,
      signature: truncate(signature),
      loc: Math.max(1, node.getEndLineNumber() - node.getStartLineNumber() + 1)
    })
  }

  for (const cls of sf.getClasses()) {
    const members = cls
      .getMethods()
      .slice(0, 6)
      .map((m) => m.getName())
    push(
      cls.getName(),
      'class',
      cls,
      cls.isExported(),
      cls.isDefaultExport(),
      `class ${cls.getName() ?? '(anonymous)'}${
        members.length ? ` { ${members.join(', ')} }` : ''
      }`
    )
  }

  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    const params = fn.getParameters().map((p) => p.getText())
    const ret = fn.getReturnTypeNode()?.getText()
    const kind: SymbolKind =
      name && looksLikeComponent(name, relPath, fn.getText())
        ? 'component'
        : 'function'
    push(
      name,
      kind,
      fn,
      fn.isExported(),
      fn.isDefaultExport(),
      `${name ?? '(anonymous)'}(${params.join(', ')})${ret ? `: ${ret}` : ''}`
    )
  }

  for (const iface of sf.getInterfaces()) {
    push(
      iface.getName(),
      'interface',
      iface,
      iface.isExported(),
      iface.isDefaultExport(),
      `interface ${iface.getName()}`
    )
  }

  for (const alias of sf.getTypeAliases()) {
    push(
      alias.getName(),
      'type',
      alias,
      alias.isExported(),
      alias.isDefaultExport(),
      `type ${alias.getName()} = ${alias.getTypeNode()?.getText() ?? ''}`
    )
  }

  for (const en of sf.getEnums()) {
    push(
      en.getName(),
      'enum',
      en,
      en.isExported(),
      en.isDefaultExport(),
      `enum ${en.getName()} { ${en
        .getMembers()
        .slice(0, 6)
        .map((m) => m.getName())
        .join(', ')} }`
    )
  }

  for (const decl of sf.getVariableDeclarations()) {
    const name = decl.getName()
    const init = decl.getInitializer()
    const initKind = init?.getKind()
    const isFunctionLike =
      initKind === SyntaxKind.ArrowFunction ||
      initKind === SyntaxKind.FunctionExpression ||
      initKind === SyntaxKind.ClassExpression
    const statement = decl.getVariableStatement()
    const exported = statement?.isExported() ?? false

    let kind: SymbolKind = 'variable'
    if (initKind === SyntaxKind.ClassExpression) kind = 'class'
    else if (isFunctionLike) {
      kind = looksLikeComponent(name, relPath, decl.getText())
        ? 'component'
        : 'function'
    }

    // Plain non-exported constants are noise in an architecture view.
    if (!exported && !isFunctionLike) continue

    push(
      name,
      kind,
      decl,
      exported,
      statement?.isDefaultExport() ?? false,
      isFunctionLike
        ? `${name}(${
            init && 'getParameters' in init
              ? (init as { getParameters(): { getText(): string }[] })
                  .getParameters()
                  .map((p) => p.getText())
                  .join(', ')
              : ''
          })`
        : `${name}: ${decl.getTypeNode()?.getText() ?? truncate(init?.getText() ?? '', 40)}`
    )
  }

  return symbols
}

function collectExportedNames(sf: SourceFile, symbols: SourceSymbol[]): string[] {
  const names = new Set<string>()
  for (const s of symbols) {
    if (s.exported) names.add(s.isDefaultExport ? `default:${s.name}` : s.name)
  }
  // `export { a, b }` and `export { x } from './y'`
  for (const decl of sf.getExportDeclarations()) {
    for (const named of decl.getNamedExports()) {
      names.add(named.getAliasNode()?.getText() ?? named.getName())
    }
    if (decl.isNamespaceExport() && decl.getModuleSpecifierValue()) {
      names.add(`*:${decl.getModuleSpecifierValue()}`)
    }
  }
  // `export default <expression>`
  if (sf.getExportAssignments().length > 0) names.add('default')
  return [...names].sort()
}

function collectImports(
  sf: SourceFile,
  relPath: string,
  resolver: SpecifierResolver
): { imports: ImportRecord[]; problems: string[] } {
  const imports: ImportRecord[] = []
  const problems: string[] = []

  const record = (
    specifier: string,
    symbols: string[],
    line: number,
    typeOnly: boolean,
    style: ImportRecord['style']
  ): void => {
    const resolved = resolver.resolve(relPath, specifier)
    if (
      resolved.resolvedPath === null &&
      !resolved.external &&
      specifier.startsWith('.')
    ) {
      problems.push(
        `${relPath}:${line} imports "${specifier}", which does not resolve to an analyzed file.`
      )
    }
    imports.push({
      specifier,
      resolvedPath: resolved.resolvedPath,
      external: resolved.external,
      packageName: resolved.packageName,
      symbols,
      line,
      typeOnly,
      style
    })
  }

  for (const decl of sf.getImportDeclarations()) {
    const names: string[] = []
    if (decl.getDefaultImport()) names.push('default')
    if (decl.getNamespaceImport()) names.push('*')
    for (const named of decl.getNamedImports()) names.push(named.getName())
    record(
      decl.getModuleSpecifierValue(),
      names,
      decl.getStartLineNumber(),
      decl.isTypeOnly(),
      'static'
    )
  }

  for (const decl of sf.getExportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue()
    if (!specifier) continue
    const names = decl.isNamespaceExport()
      ? ['*']
      : decl.getNamedExports().map((n) => n.getName())
    record(
      specifier,
      names,
      decl.getStartLineNumber(),
      decl.isTypeOnly(),
      're-export'
    )
  }

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression()
    const args = call.getArguments()
    if (args.length === 0) continue
    const first = args[0]
    if (first.getKind() !== SyntaxKind.StringLiteral) continue
    const specifier = first.getText().slice(1, -1)

    if (expr.getKind() === SyntaxKind.ImportKeyword) {
      record(specifier, ['*'], call.getStartLineNumber(), false, 'dynamic')
    } else if (expr.getText() === 'require') {
      record(specifier, ['*'], call.getStartLineNumber(), false, 'require')
    }
  }

  return { imports, problems }
}

export class TypeScriptAnalyzer implements LanguageAnalyzer {
  readonly id = 'typescript'
  readonly displayName = 'TypeScript / JavaScript'
  readonly extensions = [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs'
  ] as const

  async analyze(
    files: DiscoveredFile[],
    context: AnalyzerContext
  ): Promise<FileAnalysis[]> {
    const project = new Project({
      useInMemoryFileSystem: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        // JsxEmit.Preserve — needed so `.tsx` parses at all.
        jsx: 1,
        target: 99,
        module: 99,
        moduleResolution: 100,
        noLib: true,
        skipLibCheck: true
      }
    })

    const resolver = new SpecifierResolver({
      knownFiles: context.allFiles.map((f) => f.path),
      pathAliases: context.pathAliases,
      baseUrl: context.baseUrl
    })

    const results: FileAnalysis[] = []
    let done = 0

    for (const file of files) {
      let sf: SourceFile
      try {
        sf = project.createSourceFile(file.path, file.content, {
          overwrite: true
        })
      } catch (error) {
        results.push({
          path: file.path,
          language: file.language,
          loc: file.loc,
          symbols: [],
          exportedNames: [],
          imports: [],
          problems: [
            `Could not parse ${file.path}: ${(error as Error).message}`
          ]
        })
        done += 1
        continue
      }

      const symbols = collectSymbols(sf, file.path)
      const { imports, problems } = collectImports(sf, file.path, resolver)

      results.push({
        path: file.path,
        language: file.language,
        loc: file.loc,
        symbols,
        exportedNames: collectExportedNames(sf, symbols),
        imports,
        problems
      })

      // Releasing the source text keeps memory flat on large repositories.
      project.removeSourceFile(sf)
      done += 1
      context.onProgress?.(done, files.length, file.path)
    }

    return results
  }
}
