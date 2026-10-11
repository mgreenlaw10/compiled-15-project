/**
 * Which file extensions count as source, and what language each one is.
 *
 * This is metadata only — no parser, no filesystem, no ts-morph — so it lives
 * in `shared` and is read by three places that otherwise share nothing: the
 * scanner (which must know what to read before any analyzer runs), the ignore
 * rules, and the renderer (which tells the user what Cartograph can read).
 *
 * ---------------------------------------------------------------------------
 * Adding a language
 * ---------------------------------------------------------------------------
 * Add a descriptor below, then write and register the analyzer in
 * `src/core/analyzer/languages/`. The scanner, the ignore rules, the language
 * statistics and the canvas's empty state all follow from this list — none of
 * them need editing. See that directory's README for the whole recipe.
 */

import { basename } from '../util/paths'

export interface LanguageDescriptor {
  /** Stable id, matching the analyzer that claims these extensions. */
  id: string
  displayName: string
  /** Extensions claimed, including the leading dot, lowercase. */
  extensions: readonly string[]
  /**
   * Finer-grained language tags, most specific first. The first suffix that
   * matches names the language; this is how `.d.ts` and `.tsx` get reported
   * apart from plain `.ts` without a chain of `if`s in the scanner.
   */
  variants?: readonly { suffix: string; language: string }[]
  /** Language tag for extensions that match no variant. */
  language: string
}

export const LANGUAGES: readonly LanguageDescriptor[] = [
  {
    id: 'typescript',
    displayName: 'TypeScript / JavaScript',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    variants: [
      { suffix: '.d.ts', language: 'typescript-declaration' },
      { suffix: '.tsx', language: 'typescript-react' },
      { suffix: '.jsx', language: 'javascript-react' },
      { suffix: '.js', language: 'javascript' },
      { suffix: '.mjs', language: 'javascript' },
      { suffix: '.cjs', language: 'javascript' }
    ],
    language: 'typescript'
  }
]

/** The language tag used for files no descriptor claims. */
export const UNKNOWN_LANGUAGE = 'other'

/** Every extension any registered language claims. */
export function sourceExtensions(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.extensions))]
}

/**
 * Backwards-compatible alias. Prefer `sourceExtensions()`, which stays correct
 * as languages are added.
 */
export const SOURCE_EXTENSIONS: readonly string[] = sourceExtensions()

/** `true` when some registered language claims this file's extension. */
export function isSourcePath(relPath: string): boolean {
  const name = basename(relPath).toLowerCase()
  return LANGUAGES.some((l) => l.extensions.some((ext) => name.endsWith(ext)))
}

/** The language tag for a path, e.g. `typescript-react`, or `other`. */
export function languageOf(relPath: string): string {
  const name = basename(relPath).toLowerCase()
  for (const descriptor of LANGUAGES) {
    if (!descriptor.extensions.some((ext) => name.endsWith(ext))) continue
    for (const variant of descriptor.variants ?? []) {
      if (name.endsWith(variant.suffix)) return variant.language
    }
    return descriptor.language
  }
  return UNKNOWN_LANGUAGE
}

/** The descriptor claiming this path, if any. */
export function descriptorFor(relPath: string): LanguageDescriptor | null {
  const name = basename(relPath).toLowerCase()
  return (
    LANGUAGES.find((l) => l.extensions.some((ext) => name.endsWith(ext))) ?? null
  )
}
