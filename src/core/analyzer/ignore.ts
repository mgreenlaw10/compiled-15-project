/**
 * Which files the analyzer looks at.
 *
 * Deliberately conservative: anything that looks like a dependency directory,
 * a build output, or generated code is skipped, because including it produces a
 * module graph dominated by vendored code. The rules are plain data so they can
 * be unit-tested and extended from the settings UI.
 */

import { basename, normalizeRel, segments } from '../../shared/util/paths'

/** Directories never worth analyzing. Matched on any path segment. */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  '.cartograph',
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.vite',
  '.yarn',
  '.pnpm-store',
  '.venv',
  '__pycache__',
  '__snapshots__',
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'dist',
  'build',
  'out',
  'output',
  'coverage',
  'target',
  'bin',
  'obj',
  'tmp',
  'temp'
]

/** Filename patterns skipped regardless of directory. */
export const DEFAULT_IGNORED_FILE_PATTERNS: readonly RegExp[] = [
  /\.min\.(js|mjs|cjs|css)$/i,
  /\.bundle\.js$/i,
  /\.generated\.[cm]?[jt]sx?$/i,
  /^.*\.pb\.[cm]?[jt]s$/i,
  /\.snap$/i,
  /-lock\.json$/i,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/
]

/** Extensions the analyzer treats as source code it can reason about. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
]

/** Marker comment that identifies machine-written files. */
const GENERATED_MARKER = /^\s*(\/\/|\/\*|\*|#)\s*@?generated\b/im

export interface IgnoreRules {
  directories: Set<string>
  filePatterns: RegExp[]
  /** Simple gitignore-derived prefixes and names. */
  gitignoreNames: Set<string>
  gitignorePrefixes: string[]
}

export function createIgnoreRules(options: {
  extraIgnores?: string[]
  gitignore?: string
} = {}): IgnoreRules {
  const directories = new Set<string>(DEFAULT_IGNORED_DIRECTORIES)
  const filePatterns = [...DEFAULT_IGNORED_FILE_PATTERNS]
  const gitignoreNames = new Set<string>()
  const gitignorePrefixes: string[] = []

  for (const raw of options.extraIgnores ?? []) {
    const value = raw.trim()
    if (value === '') continue
    if (value.includes('*') || value.includes('.')) {
      filePatterns.push(globToRegExp(value))
    } else {
      directories.add(value.replace(/\/$/, ''))
    }
  }

  // A deliberately small subset of .gitignore: literal names, directory
  // entries, and rooted prefixes. Anything more exotic is left to the
  // defaults rather than silently mis-parsed.
  for (const line of (options.gitignore ?? '').split(/\r?\n/)) {
    const value = line.trim()
    if (value === '' || value.startsWith('#') || value.startsWith('!')) continue
    if (value.includes('*')) {
      filePatterns.push(globToRegExp(value.replace(/^\//, '')))
      continue
    }
    const cleaned = value.replace(/\/$/, '')
    if (cleaned.startsWith('/')) gitignorePrefixes.push(normalizeRel(cleaned))
    else if (cleaned.includes('/')) gitignorePrefixes.push(normalizeRel(cleaned))
    else gitignoreNames.add(cleaned)
  }

  return { directories, filePatterns, gitignoreNames, gitignorePrefixes }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/** `true` when a directory (given as a project-relative path) should be skipped. */
export function shouldIgnoreDirectory(
  relPath: string,
  rules: IgnoreRules
): boolean {
  const name = basename(relPath)
  if (rules.directories.has(name)) return true
  if (rules.gitignoreNames.has(name)) return true
  const norm = normalizeRel(relPath)
  if (rules.gitignorePrefixes.some((p) => norm === p || norm.startsWith(`${p}/`)))
    return true
  return false
}

/** `true` when a file should not be analyzed at all. */
export function shouldIgnoreFile(relPath: string, rules: IgnoreRules): boolean {
  const name = basename(relPath)
  if (rules.filePatterns.some((re) => re.test(name))) return true
  if (rules.gitignoreNames.has(name)) return true
  const norm = normalizeRel(relPath)
  if (rules.gitignorePrefixes.some((p) => norm === p || norm.startsWith(`${p}/`)))
    return true
  if (segments(norm).some((seg) => rules.directories.has(seg))) return true
  return false
}

export function isSourceFile(relPath: string): boolean {
  const name = basename(relPath).toLowerCase()
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))
}

/** `true` when the file's own header marks it as generated. */
export function looksGenerated(content: string): boolean {
  return GENERATED_MARKER.test(content.slice(0, 500))
}

export function languageOf(relPath: string): string {
  const name = basename(relPath).toLowerCase()
  if (name.endsWith('.d.ts')) return 'typescript-declaration'
  if (name.endsWith('.tsx')) return 'typescript-react'
  if (name.endsWith('.ts') || name.endsWith('.mts') || name.endsWith('.cts'))
    return 'typescript'
  if (name.endsWith('.jsx')) return 'javascript-react'
  if (
    name.endsWith('.js') ||
    name.endsWith('.mjs') ||
    name.endsWith('.cjs')
  )
    return 'javascript'
  return 'other'
}
