/**
 * Module specifier resolution.
 *
 * Written by hand rather than delegated to the TypeScript resolver because the
 * answer has to be deterministic, has to work on a file set that excludes
 * `node_modules`, and has to be unit-testable without a real filesystem.
 *
 * It understands relative specifiers, tsconfig `paths` aliases, and the usual
 * extension/`index` conventions. Anything it cannot place inside the project is
 * reported as an external package, which is the honest answer.
 */

import { dirname, join, normalizeRel, resolveSpecifier } from '../../shared/util/paths'

/** Order matters: `.ts` wins over `.js` when both exist. */
const EXTENSION_CANDIDATES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
]

const INDEX_CANDIDATES = [
  'index.ts',
  'index.tsx',
  'index.mts',
  'index.cts',
  'index.d.ts',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs'
]

export interface ResolverOptions {
  /** Every project-relative POSIX path in the project. */
  knownFiles: Iterable<string>
  /** tsconfig `compilerOptions.paths`. */
  pathAliases?: Record<string, string[]>
  /** tsconfig `compilerOptions.baseUrl`, project-relative. */
  baseUrl?: string
}

export interface ResolvedImport {
  resolvedPath: string | null
  external: boolean
  packageName: string | null
}

/** Extracts the package name from a bare specifier (handles `@scope/name`). */
export function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.slice(0, 2).join('/')
  }
  return specifier.split('/')[0]
}

export class SpecifierResolver {
  private readonly files: Set<string>
  private readonly aliases: [string, string[]][]
  private readonly baseUrl: string

  constructor(options: ResolverOptions) {
    this.files = new Set([...options.knownFiles].map(normalizeRel))
    this.baseUrl = normalizeRel(options.baseUrl ?? '')
    // Longest pattern first so `@app/db/*` beats `@app/*`.
    this.aliases = Object.entries(options.pathAliases ?? {}).sort(
      (a, b) => b[0].length - a[0].length
    )
  }

  private tryFile(candidate: string): string | null {
    const base = normalizeRel(candidate)
    for (const ext of EXTENSION_CANDIDATES) {
      const withExt = `${base}${ext}`
      if (this.files.has(withExt)) return withExt
    }
    for (const index of INDEX_CANDIDATES) {
      const withIndex = join(base, index)
      if (this.files.has(withIndex)) return withIndex
    }
    // `./foo.js` in ESM/TS source usually means `./foo.ts` on disk.
    const rewritten = base.replace(/\.(m|c)?js$/, '')
    if (rewritten !== base) {
      for (const ext of EXTENSION_CANDIDATES) {
        const withExt = `${rewritten}${ext}`
        if (this.files.has(withExt)) return withExt
      }
    }
    return null
  }

  resolve(fromFile: string, specifier: string): ResolvedImport {
    if (specifier.startsWith('.')) {
      const target = resolveSpecifier(fromFile, specifier)
      const hit = this.tryFile(target)
      return hit
        ? { resolvedPath: hit, external: false, packageName: null }
        : { resolvedPath: null, external: false, packageName: null }
    }

    if (specifier.startsWith('/')) {
      const hit = this.tryFile(normalizeRel(specifier))
      return hit
        ? { resolvedPath: hit, external: false, packageName: null }
        : { resolvedPath: null, external: false, packageName: null }
    }

    if (specifier.startsWith('node:')) {
      return {
        resolvedPath: null,
        external: true,
        packageName: specifier
      }
    }

    for (const [pattern, targets] of this.aliases) {
      const match = matchAlias(pattern, specifier)
      if (match === null) continue
      for (const target of targets) {
        const candidate = normalizeRel(
          join(this.baseUrl, target.replace('*', match))
        )
        const hit = this.tryFile(candidate)
        if (hit) return { resolvedPath: hit, external: false, packageName: null }
      }
    }

    // Bare specifier that is not an alias: try baseUrl-relative (the classic
    // non-relative-import setup) before calling it external.
    if (this.baseUrl !== '' || this.aliases.length > 0) {
      const hit = this.tryFile(join(this.baseUrl, specifier))
      if (hit) return { resolvedPath: hit, external: false, packageName: null }
    }

    return {
      resolvedPath: null,
      external: true,
      packageName: packageNameOf(specifier)
    }
  }
}

function matchAlias(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === specifier ? '' : null
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

/**
 * Reads `compilerOptions.baseUrl`/`paths` out of a tsconfig's text.
 * Uses a tolerant JSON parse because tsconfigs routinely contain comments and
 * trailing commas, and a broken tsconfig must not fail the whole analysis.
 */
export function parseTsConfigPaths(text: string): {
  baseUrl: string
  paths: Record<string, string[]>
} {
  try {
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1')
    const parsed = JSON.parse(stripped) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
    }
    return {
      baseUrl: normalizeRel(parsed.compilerOptions?.baseUrl ?? ''),
      paths: parsed.compilerOptions?.paths ?? {}
    }
  } catch {
    return { baseUrl: '', paths: {} }
  }
}

/** Directory of a file, for callers that only import this module. */
export const directoryOf = dirname
