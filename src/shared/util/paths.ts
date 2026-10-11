/**
 * Path helpers that work on project-relative POSIX paths.
 *
 * The whole architecture model stores POSIX paths regardless of host OS, so
 * saved documents are portable and tests behave the same on Windows and Linux.
 * Conversion to native paths happens only at the filesystem boundary.
 */

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export function normalizeRel(p: string): string {
  const posix = toPosix(p).replace(/^\.\//, '')
  const parts: string[] = []
  for (const seg of posix.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

export function dirname(p: string): string {
  const norm = normalizeRel(p)
  const i = norm.lastIndexOf('/')
  return i === -1 ? '' : norm.slice(0, i)
}

export function basename(p: string): string {
  const norm = normalizeRel(p)
  const i = norm.lastIndexOf('/')
  return i === -1 ? norm : norm.slice(i + 1)
}

export function extname(p: string): string {
  const base = basename(p)
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i)
}

export function stripExtension(p: string): string {
  const ext = extname(p)
  return ext ? p.slice(0, -ext.length) : p
}

export function join(...parts: string[]): string {
  return normalizeRel(parts.filter((p) => p !== '').join('/'))
}

export function segments(p: string): string[] {
  const norm = normalizeRel(p)
  return norm === '' ? [] : norm.split('/')
}

/** `true` when `child` is inside `parent` (or equal to it). */
export function isWithin(parent: string, child: string): boolean {
  const a = normalizeRel(parent)
  const b = normalizeRel(child)
  if (a === '') return true
  return b === a || b.startsWith(`${a}/`)
}

export function commonDirectory(paths: string[]): string {
  if (paths.length === 0) return ''
  const split = paths.map((p) => segments(dirname(p)))
  let prefix = split[0]
  for (const parts of split.slice(1)) {
    const next: string[] = []
    for (let i = 0; i < Math.min(prefix.length, parts.length); i += 1) {
      if (prefix[i] !== parts[i]) break
      next.push(prefix[i])
    }
    prefix = next
    if (prefix.length === 0) break
  }
  return prefix.join('/')
}

export interface SpecifierOptions {
  /** Turn `../auth/index` into `../auth`. Default `true`. */
  collapseIndex?: boolean
  /** Extension to append, e.g. `.ts`. Default: none. */
  extension?: string | null
}

/**
 * Relative module specifier from one file to another, in the form TypeScript
 * wants: always prefixed with `./` or `../`, extension dropped by default, and
 * `/index` collapsed to the directory.
 *
 * Both of those conventions are configurable because a codebase that writes
 * `./session.ts` explicitly must keep writing it that way after a refactor —
 * rewriting imports is only correct if it preserves the project's own style.
 */
export function relativeSpecifier(
  fromFile: string,
  toFile: string,
  options: SpecifierOptions = {}
): string {
  const collapseIndex = options.collapseIndex ?? true
  const fromDir = segments(dirname(fromFile))
  let target = stripExtension(normalizeRel(toFile))
  if (collapseIndex) {
    if (target.endsWith('/index')) target = target.slice(0, -'/index'.length)
    else if (target === 'index') target = '.'
  }
  const to = segments(target)

  let i = 0
  while (i < fromDir.length && i < to.length && fromDir[i] === to[i]) i += 1

  const up = fromDir.length - i
  const parts = [...Array.from({ length: up }, () => '..'), ...to.slice(i)]
  const suffix = options.extension ?? ''
  if (parts.length === 0) return `.${suffix}`
  const joined = parts.join('/') + suffix
  return up === 0 ? `./${joined}` : joined
}

/** Resolves a relative specifier written in `fromFile` to a project path. */
export function resolveSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier
  return normalizeRel(`${dirname(fromFile)}/${specifier}`)
}
