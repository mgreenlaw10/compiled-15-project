/**
 * Language metadata, shared by the backend and the UI.
 *
 * The analyzers themselves live in `src/core/analyzer/languages/`; this is the
 * part the renderer is allowed to know about.
 */

export * from './catalog'

import { LANGUAGES } from './catalog'

/**
 * Human-readable list of what the analyzer understands, for log lines and the
 * canvas's empty state. Derived from the catalog so it cannot go stale.
 */
export function supportedLanguagesSentence(): string {
  const names = LANGUAGES.map((l) => l.displayName)
  if (names.length === 0) return 'no languages'
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
