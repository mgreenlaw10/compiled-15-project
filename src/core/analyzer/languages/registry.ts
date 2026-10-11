/**
 * The analyzer registry: which analyzer handles which files.
 */

import type { DiscoveredFile } from '../scan'
import type { LanguageAnalyzer } from './types'

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
