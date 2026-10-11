/**
 * The language manifest.
 *
 * One place that says which languages Cartograph can read. Everything else —
 * the scanner's idea of a source file, the ignore rules, the per-language file
 * counts in the status bar, the partitioning of files to analyzers — derives
 * from here and from `./catalog.ts`.
 *
 * ---------------------------------------------------------------------------
 * Adding a language
 * ---------------------------------------------------------------------------
 * 1. Add a descriptor to `LANGUAGES` in `src/shared/languages/catalog.ts`
 *    (extensions, display name, language tags). It lives in `shared` because
 *    the renderer reads it too.
 * 2. Write the analyzer in `./<language>/`, implementing `LanguageAnalyzer`
 *    from `./types.ts`: given discovered files, return per-file symbols and
 *    imports. Report facts only — `problems` is for anything that did not
 *    parse or resolve, and nothing here should guess.
 * 3. Register it in `createDefaultRegistry` below.
 *
 * That is the whole change. In particular you should not need to touch
 * `../ignore.ts`, `../scan.ts` or `../index.ts`; if you find yourself wanting
 * to, the seam is in the wrong place and it is worth fixing rather than
 * working around.
 *
 * Two caveats worth knowing before you start, because they are not visible
 * from this file:
 *
 *   - Import *rewriting* (used when files move between modules) is handled by
 *     `src/core/transform/imports.ts`, which is TypeScript-specific today. A
 *     new language can be analyzed and drawn without it; moving its files
 *     between modules needs the equivalent there.
 *   - `src/core/output/validate.ts` runs `tsc` and `npm test`. Validation for
 *     another toolchain belongs there.
 */

import { LanguageRegistry } from './registry'
import { TypeScriptAnalyzer } from './typescript'

export * from '../../../shared/languages'
export * from './registry'
export * from './types'

/** The registry the app analyzes with. Register further languages here. */
export function createDefaultRegistry(): LanguageRegistry {
  return new LanguageRegistry().register(new TypeScriptAnalyzer())
}
