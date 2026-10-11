/**
 * The language-analyzer interface.
 *
 * Static analysis is the only source of *factual* dependency information in
 * Cartograph, so it is kept behind a narrow contract: a language analyzer takes
 * a set of discovered files and returns per-file symbols and imports. Nothing
 * downstream (clustering, graph building, the GUI) knows which language a fact
 * came from.
 *
 * See `./README.md` for how to add a language.
 */

import type { SourceSymbol } from '../../../shared/types/architecture'
import type { DiscoveredFile } from '../scan'

export interface ImportRecord {
  /** The specifier exactly as written, e.g. `'../db/client'` or `'react'`. */
  specifier: string
  /** Project-relative POSIX path when the import resolves inside the project. */
  resolvedPath: string | null
  external: boolean
  /** Package name for external imports, e.g. `@scope/pkg`. */
  packageName: string | null
  /** Imported binding names; `['*']` for namespace imports, `['default']`. */
  symbols: string[]
  line: number
  typeOnly: boolean
  /** `import()`, `require()`, or a static `import` statement. */
  style: 'static' | 'dynamic' | 'require' | 're-export'
}

export interface FileAnalysis {
  /** Project-relative POSIX path. */
  path: string
  language: string
  loc: number
  symbols: SourceSymbol[]
  /** Names this file exports. */
  exportedNames: string[]
  imports: ImportRecord[]
  /** Parse or resolution problems, surfaced in the analysis log. */
  problems: string[]
}

export interface AnalyzerContext {
  projectRoot: string
  /** Every discovered source file, for import resolution. */
  allFiles: DiscoveredFile[]
  /** tsconfig `compilerOptions.paths`-style aliases, if any. */
  pathAliases: Record<string, string[]>
  baseUrl: string
  onProgress?: (done: number, total: number, current: string) => void
}

export interface LanguageAnalyzer {
  id: string
  displayName: string
  /** Extensions this analyzer claims, including the leading dot. */
  extensions: readonly string[]
  analyze(
    files: DiscoveredFile[],
    context: AnalyzerContext
  ): Promise<FileAnalysis[]>
}
