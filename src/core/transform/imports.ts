/**
 * Import rewriting.
 *
 * When a file moves, two sets of module specifiers go stale: the ones written
 * inside the moved file, and the ones in every file that imports it. Getting
 * this wrong is the difference between a refactor and a broken project, so the
 * rewriter is deliberately explicit rather than delegated:
 *
 *   - specifiers are resolved against the *pre-move* file layout, so we know
 *     what each one actually pointed at,
 *   - the replacement is computed against the *post-move* layout,
 *   - and the project's own style is preserved: a codebase that writes
 *     `./session.ts` keeps its extensions, one that writes `../auth` keeps
 *     collapsing `index` files.
 *
 * Only the string literal inside a specifier is edited, so comments,
 * formatting, and everything else in the file survive untouched.
 */

import {
  Project,
  QuoteKind,
  SyntaxKind,
  type SourceFile,
  type StringLiteral
} from 'ts-morph'

import { SpecifierResolver } from '../analyzer/resolve'
import { extname, normalizeRel, relativeSpecifier } from '../../shared/util/paths'
import type { VirtualWorkspace } from './workspace'

const ANALYZABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i

const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs']
const TS_TO_JS: Record<string, string> = {
  '.ts': '.js',
  '.tsx': '.jsx',
  '.mts': '.mjs',
  '.cts': '.cjs'
}

export interface SpecifierStyle {
  /** The extension the original specifier used, or `null` if it had none. */
  extension: string | null
  /** `true` when the original specifier named `index` explicitly. */
  explicitIndex: boolean
}

const KNOWN_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json'
]

export function specifierStyle(specifier: string): SpecifierStyle {
  const extension =
    KNOWN_EXTENSIONS.find((ext) => specifier.toLowerCase().endsWith(ext)) ?? null
  return {
    extension,
    explicitIndex: /(^|\/)index(\.[A-Za-z]+)?$/.test(specifier)
  }
}

/**
 * The extension a rewritten specifier should carry. If the project writes
 * `.js` while importing a `.ts` file (the ESM/NodeNext convention), keep doing
 * that rather than silently switching to `.ts`.
 */
export function targetExtension(
  style: SpecifierStyle,
  targetPath: string
): string | null {
  if (style.extension === null) return null
  const actual = targetPath.toLowerCase().endsWith('.d.ts')
    ? '.d.ts'
    : extname(targetPath)
  if (JS_EXTENSIONS.includes(style.extension.toLowerCase())) {
    return TS_TO_JS[actual.toLowerCase()] ?? style.extension
  }
  return actual
}

/** Recomputes a specifier for a new importer/target pair, keeping its style. */
export function rewriteSpecifier(
  fromFile: string,
  toFile: string,
  originalSpecifier: string
): string {
  return buildSpecifier(fromFile, toFile, specifierStyle(originalSpecifier))
}

/** `true` when the path's file name is `index.<ext>`. */
export function isIndexFile(filePath: string): boolean {
  return /(^|\/)index\.[A-Za-z]+$/.test(filePath)
}

/**
 * Builds a specifier in a given style.
 *
 * Index files get special treatment because the two conventions do not compose:
 * `../auth` and `../auth/index.ts` both resolve, but `../auth.ts` — collapsing
 * the directory *and* keeping the extension — points at a file that does not
 * exist. So when the target is an index file, the specifier either names it in
 * full (with the extension, which resolves under every `moduleResolution`
 * setting) or collapses to the directory with no extension at all.
 */
export function buildSpecifier(
  fromFile: string,
  toFile: string,
  style: SpecifierStyle
): string {
  const extension = targetExtension(style, toFile)

  if (isIndexFile(toFile)) {
    return extension === null
      ? relativeSpecifier(fromFile, toFile, { collapseIndex: true, extension: null })
      : relativeSpecifier(fromFile, toFile, {
          collapseIndex: false,
          extension
        })
  }

  return relativeSpecifier(fromFile, toFile, {
    collapseIndex: !style.explicitIndex,
    extension
  })
}

/**
 * Works out how a file writes its relative imports, so generated imports match.
 *
 * A project that writes `./session.ts` and one that writes `./session` are both
 * valid and mutually exclusive — `allowImportingTsExtensions` makes the first
 * legal, `moduleResolution: bundler` makes the second idiomatic — so new
 * imports have to follow whatever the file already does rather than a default.
 */
export function inferSpecifierStyle(
  content: string,
  fallback: SpecifierStyle = { extension: null, explicitIndex: false }
): SpecifierStyle {
  const matches = content.matchAll(/from\s*['"](\.[^'"]*)['"]|require\(\s*['"](\.[^'"]*)['"]/g)
  const extensions = new Map<string, number>()
  let withExtension = 0
  let withoutExtension = 0
  let explicitIndex = 0
  let total = 0

  for (const match of matches) {
    const specifier = match[1] ?? match[2]
    if (!specifier) continue
    total += 1
    const style = specifierStyle(specifier)
    if (style.extension) {
      withExtension += 1
      extensions.set(style.extension, (extensions.get(style.extension) ?? 0) + 1)
    } else {
      withoutExtension += 1
    }
    if (style.explicitIndex) explicitIndex += 1
  }

  if (total === 0) return fallback

  const dominant = [...extensions.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )[0]

  return {
    extension: withExtension > withoutExtension && dominant ? dominant[0] : null,
    explicitIndex: explicitIndex > total / 2
  }
}

/** The quote character a file prefers for its module specifiers. */
export function inferQuoteKind(content: string): QuoteKind {
  const single = (content.match(/from\s*'/g) ?? []).length
  const double = (content.match(/from\s*"/g) ?? []).length
  return double > single ? QuoteKind.Double : QuoteKind.Single
}

/** Every module-specifier string literal in a file, whatever syntax it uses. */
export function specifierLiterals(sf: SourceFile): StringLiteral[] {
  const literals: StringLiteral[] = []

  for (const decl of sf.getImportDeclarations()) {
    const literal = decl.getModuleSpecifier()
    if (literal) literals.push(literal)
  }
  for (const decl of sf.getExportDeclarations()) {
    const literal = decl.getModuleSpecifier()
    if (literal) literals.push(literal)
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression()
    const isDynamicImport = expr.getKind() === SyntaxKind.ImportKeyword
    const isRequire = expr.getText() === 'require'
    if (!isDynamicImport && !isRequire) continue
    const [first] = call.getArguments()
    if (first && first.getKind() === SyntaxKind.StringLiteral) {
      literals.push(first as StringLiteral)
    }
  }
  return literals
}

export interface RewriteReport {
  /** Files whose text changed. */
  touched: string[]
  /** Number of individual specifiers rewritten. */
  rewritten: number
  /**
   * Specifiers that pointed at a moved file but could not be rewritten.
   * Surfaced to the user rather than ignored.
   */
  unresolved: { file: string; specifier: string; line: number }[]
  /**
   * Imports that now cross a module boundary they did not cross before, e.g. a
   * barrel file that still re-exports a file which moved to another module.
   */
  newCrossReferences: { file: string; specifier: string; target: string }[]
}

function createProject(quoteKind: QuoteKind = QuoteKind.Single): Project {
  return new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    // Generated imports should look like the ones already in the file.
    manipulationSettings: { quoteKind },
    compilerOptions: {
      allowJs: true,
      jsx: 1,
      target: 99,
      module: 99,
      noLib: true,
      skipLibCheck: true
    }
  })
}

/**
 * Applies a set of file moves to the workspace and fixes every affected
 * specifier. `moves` maps current paths to their new paths.
 */
export function applyMovesWithImportRewrite(
  workspace: VirtualWorkspace,
  moves: Map<string, string>,
  options: { reason: string; operationId: string }
): RewriteReport {
  const report: RewriteReport = {
    touched: [],
    rewritten: 0,
    unresolved: [],
    newCrossReferences: []
  }
  if (moves.size === 0) return report

  const normalizedMoves = new Map<string, string>()
  for (const [from, to] of moves) {
    normalizedMoves.set(normalizeRel(from), normalizeRel(to))
  }

  // Resolve against the layout as it is *now*, before anything moves.
  const beforeFiles = workspace.listFiles()
  const resolver = new SpecifierResolver({ knownFiles: beforeFiles })
  const project = createProject()

  const pendingWrites = new Map<string, string>()

  for (const file of beforeFiles) {
    if (!ANALYZABLE.test(file)) continue
    const content = workspace.read(file)
    if (content === null) continue

    const newFilePath = normalizedMoves.get(file) ?? file
    const sf = project.createSourceFile(file, content, { overwrite: true })
    let changed = false

    for (const literal of specifierLiterals(sf)) {
      const specifier = literal.getLiteralValue()
      if (!specifier.startsWith('.')) continue

      const resolved = resolver.resolve(file, specifier)
      if (resolved.resolvedPath === null) {
        // Already broken before we touched it; only report it if the file
        // itself is moving, since the specifier is about to change meaning.
        if (newFilePath !== file) {
          report.unresolved.push({
            file,
            specifier,
            line: literal.getStartLineNumber()
          })
        }
        continue
      }

      const target = resolved.resolvedPath
      const newTarget = normalizedMoves.get(target) ?? target
      if (newTarget === target && newFilePath === file) continue

      const next = rewriteSpecifier(newFilePath, newTarget, specifier)
      if (next !== specifier) {
        literal.setLiteralValue(next)
        report.rewritten += 1
        changed = true
      }
    }

    if (changed) pendingWrites.set(file, sf.getFullText())
    project.removeSourceFile(sf)
  }

  // Write the rewritten text first, then move: `move` carries content along.
  for (const [file, content] of pendingWrites) {
    workspace.write(file, content, options)
    report.touched.push(file)
  }
  for (const [from, to] of normalizedMoves) {
    if (from === to) continue
    workspace.move(from, to, options)
    if (!report.touched.includes(to)) report.touched.push(to)
  }

  report.touched = [...new Set(report.touched)].sort()
  return report
}

/**
 * Finds every file that imports `target`, with the specifier used.
 * Used to warn about references that a deletion would break, and to locate the
 * importers of a symbol that is being moved.
 */
export function findImporters(
  workspace: VirtualWorkspace,
  target: string
): { file: string; specifier: string; symbols: string[]; line: number }[] {
  const files = workspace.listFiles()
  const resolver = new SpecifierResolver({ knownFiles: files })
  const project = createProject()
  const wanted = normalizeRel(target)
  const importers: {
    file: string
    specifier: string
    symbols: string[]
    line: number
  }[] = []

  for (const file of files) {
    if (!ANALYZABLE.test(file) || file === wanted) continue
    const content = workspace.read(file)
    if (content === null) continue
    const sf = project.createSourceFile(file, content, { overwrite: true })

    for (const decl of sf.getImportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue()
      if (resolver.resolve(file, specifier).resolvedPath !== wanted) continue
      const symbols: string[] = []
      if (decl.getDefaultImport()) symbols.push('default')
      if (decl.getNamespaceImport()) symbols.push('*')
      for (const named of decl.getNamedImports()) symbols.push(named.getName())
      importers.push({
        file,
        specifier,
        symbols,
        line: decl.getStartLineNumber()
      })
    }

    for (const decl of sf.getExportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue()
      if (!specifier) continue
      if (resolver.resolve(file, specifier).resolvedPath !== wanted) continue
      importers.push({
        file,
        specifier,
        symbols: decl.isNamespaceExport()
          ? ['*']
          : decl.getNamedExports().map((n) => n.getName()),
        line: decl.getStartLineNumber()
      })
    }

    project.removeSourceFile(sf)
  }

  return importers
}

/** A shared ts-morph project for callers that need to parse workspace files. */
export function parseWorkspaceFile(
  workspace: VirtualWorkspace,
  file: string
): { project: Project; sourceFile: SourceFile } | null {
  const content = workspace.read(file)
  if (content === null) return null
  const project = createProject()
  return {
    project,
    sourceFile: project.createSourceFile(file, content, { overwrite: true })
  }
}

export { createProject as createTransformProject }
