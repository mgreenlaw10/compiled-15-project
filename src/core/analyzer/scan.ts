/**
 * Recursive project scan.
 *
 * Produces the raw material every later stage works from: the set of source
 * files, a file tree for the explorer, and the "source roots" (e.g. `src/`)
 * that the clustering step uses to decide where modules begin.
 */

import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'

import type { FileTreeNode, ProjectInfo } from '../../shared/types/project'
import { basename, toPosix } from '../../shared/util/paths'
import {
  createIgnoreRules,
  isSourceFile,
  languageOf,
  looksGenerated,
  shouldIgnoreDirectory,
  shouldIgnoreFile,
  type IgnoreRules
} from './ignore'

export interface DiscoveredFile {
  /** Project-relative POSIX path. */
  path: string
  /** Absolute native path. */
  absolutePath: string
  language: string
  loc: number
  byteSize: number
  content: string
}

export interface ScanResult {
  files: DiscoveredFile[]
  /** Source files found but intentionally not parsed, with the reason. */
  skipped: { path: string; reason: string }[]
  tree: FileTreeNode
  /** Directories treated as the roots of first-party code. */
  sourceRoots: string[]
  totalFileCount: number
  loc: number
  languages: Record<string, number>
}

export interface ScanOptions {
  extraIgnores?: string[]
  /** Files above this size are listed but not parsed. */
  maxFileBytes?: number
  onProgress?: (scanned: number, currentPath: string) => void
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

export async function readProjectInfo(root: string): Promise<ProjectInfo> {
  const pkgRaw = await readIfExists(path.join(root, 'package.json'))
  let packageName: string | null = null
  let scripts: Record<string, string> = {}
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        name?: string
        scripts?: Record<string, string>
      }
      packageName = typeof pkg.name === 'string' ? pkg.name : null
      scripts = pkg.scripts ?? {}
    } catch {
      // A malformed package.json is not fatal for analysis.
    }
  }

  const tsconfigNames = ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json']
  let hasTsConfig = false
  for (const name of tsconfigNames) {
    if ((await readIfExists(path.join(root, name))) !== null) {
      hasTsConfig = true
      break
    }
  }

  let isGitRepo = false
  try {
    const stat = await fs.stat(path.join(root, '.git'))
    isGitRepo = stat.isDirectory() || stat.isFile()
  } catch {
    isGitRepo = false
  }

  return {
    root,
    name: packageName ?? basename(toPosix(root)) ?? root,
    packageName,
    hasPackageJson: pkgRaw !== null,
    hasTsConfig,
    isGitRepo,
    hasTestScript: typeof scripts.test === 'string' && scripts.test.trim() !== '',
    scripts
  }
}

/** Candidate source-root directory names, most conventional first. */
const SOURCE_ROOT_CANDIDATES = ['src', 'lib', 'app', 'source', 'packages']

function pickSourceRoots(files: DiscoveredFile[]): string[] {
  const topLevel = new Map<string, number>()
  let rootLevelFiles = 0
  for (const f of files) {
    const parts = f.path.split('/')
    if (parts.length === 1) {
      rootLevelFiles += 1
      continue
    }
    topLevel.set(parts[0], (topLevel.get(parts[0]) ?? 0) + 1)
  }

  const conventional = SOURCE_ROOT_CANDIDATES.filter((c) => topLevel.has(c))
  if (conventional.length > 0) {
    // Only keep conventional roots that hold a meaningful share of the code.
    const total = files.length
    const kept = conventional.filter(
      (c) => (topLevel.get(c) ?? 0) / Math.max(total, 1) >= 0.15
    )
    if (kept.length > 0) return kept
    return conventional
  }

  // No conventional root: treat the project root itself as the source root,
  // unless almost everything lives in one directory.
  const sorted = [...topLevel.entries()].sort((a, b) => b[1] - a[1])
  if (
    sorted.length > 0 &&
    rootLevelFiles === 0 &&
    sorted[0][1] / Math.max(files.length, 1) > 0.8
  ) {
    return [sorted[0][0]]
  }
  return ['']
}

export async function scanProject(
  root: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const gitignore = await readIfExists(path.join(root, '.gitignore'))
  const rules: IgnoreRules = createIgnoreRules({
    extraIgnores: options.extraIgnores,
    gitignore: gitignore ?? undefined
  })
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES

  const files: DiscoveredFile[] = []
  const skipped: { path: string; reason: string }[] = []
  const languages: Record<string, number> = {}
  let totalFileCount = 0
  let scanned = 0

  const walk = async (
    absDir: string,
    relDir: string
  ): Promise<FileTreeNode[]> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return []
    }

    const nodes: FileTreeNode[] = []
    const sorted = [...entries].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const entry of sorted) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const abs = path.join(absDir, entry.name)

      if (entry.isSymbolicLink()) {
        // Following links risks cycles and escaping the project; list only.
        nodes.push({ name: entry.name, path: rel, type: 'file' })
        continue
      }

      if (entry.isDirectory()) {
        if (shouldIgnoreDirectory(rel, rules)) continue
        const children = await walk(abs, rel)
        nodes.push({
          name: entry.name,
          path: rel,
          type: 'directory',
          children
        })
        continue
      }

      if (!entry.isFile()) continue
      totalFileCount += 1
      nodes.push({ name: entry.name, path: rel, type: 'file' })

      if (shouldIgnoreFile(rel, rules)) continue
      if (!isSourceFile(rel)) continue

      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(abs)
      } catch {
        skipped.push({ path: rel, reason: 'unreadable' })
        continue
      }
      if (stat.size > maxBytes) {
        skipped.push({
          path: rel,
          reason: `larger than ${Math.round(maxBytes / 1024)} KB`
        })
        continue
      }

      let content: string
      try {
        content = await fs.readFile(abs, 'utf8')
      } catch {
        skipped.push({ path: rel, reason: 'unreadable' })
        continue
      }
      if (looksGenerated(content)) {
        skipped.push({ path: rel, reason: 'marked as generated' })
        continue
      }

      const language = languageOf(rel)
      const loc = content.length === 0 ? 0 : content.split('\n').length
      languages[language] = (languages[language] ?? 0) + 1
      files.push({
        path: rel,
        absolutePath: abs,
        language,
        loc,
        byteSize: stat.size,
        content
      })
      scanned += 1
      options.onProgress?.(scanned, rel)
    }

    return nodes
  }

  const children = await walk(root, '')
  const tree: FileTreeNode = {
    name: basename(toPosix(root)) || root,
    path: '',
    type: 'directory',
    children
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  return {
    files,
    skipped,
    tree,
    sourceRoots: pickSourceRoots(files),
    totalFileCount,
    loc: files.reduce((sum, f) => sum + f.loc, 0),
    languages
  }
}
