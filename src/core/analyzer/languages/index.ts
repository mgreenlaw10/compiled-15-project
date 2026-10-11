/**
 * The language analyzer registry.
 *
 * Static analysis is the only source of *factual* dependency information in
 * Cartograph, so it is kept behind a narrow interface: a language analyzer
 * takes a set of discovered files and returns per-file symbols and imports.
 * Adding Python or Go later means implementing this interface and registering
 * it — nothing downstream (clustering, graph building, the GUI) needs to know
 * which language it came from.
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

export class LanguageRegistry {
  private readonly analyzers: LanguageAnalyzer[] = []

  register(analyzer: LanguageAnalyzer): this {
    this.analyzers.push(analyzer)
    return this
  }

  /** Groups files by the analyzer that claims their extension. */
  partition(
    files: DiscoveredFile[]
  ): { analyzer: LanguageAnalyzer; files: DiscoveredFile[] }[] {
    const buckets = new Map<string, DiscoveredFile[]>()
    const unclaimed: DiscoveredFile[] = []

    for (const file of files) {
      const analyzer = this.analyzers.find((a) =>
        a.extensions.some((ext) => file.path.toLowerCase().endsWith(ext))
      )
      if (!analyzer) {
        unclaimed.push(file)
        continue
      }
      const list = buckets.get(analyzer.id) ?? []
      list.push(file)
      buckets.set(analyzer.id, list)
    }

    const result = this.analyzers
      .filter((a) => (buckets.get(a.id)?.length ?? 0) > 0)
      .map((a) => ({ analyzer: a, files: buckets.get(a.id)! }))

    if (unclaimed.length > 0) {
      // Reported by the caller as skipped files rather than silently dropped.
      result.push({ analyzer: nullAnalyzer, files: unclaimed })
    }
    return result
  }

  get supportedExtensions(): string[] {
    return this.analyzers.flatMap((a) => [...a.extensions])
  }
}

/** Records files no analyzer understands, so the UI can say so out loud. */
export const nullAnalyzer: LanguageAnalyzer = {
  id: 'unsupported',
  displayName: 'Unsupported',
  extensions: [],
  async analyze(files) {
    return files.map((f) => ({
      path: f.path,
      language: f.language,
      loc: f.loc,
      symbols: [],
      exportedNames: [],
      imports: [],
      problems: [`No analyzer is registered for ${f.path}; treated as an opaque file.`]
    }))
  }
}
