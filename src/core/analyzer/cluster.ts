/**
 * Grouping files into modules.
 *
 * A module is a *logical* component, not a file — so this step has to make a
 * judgement call. The strategy, in order of preference:
 *
 *   1. Directory structure, because in a real codebase the directory layout is
 *      the architecture the author already committed to.
 *   2. Splitting a directory that has grown large into its subdirectories.
 *   3. For a large flat directory with no subdirectories, grouping files by the
 *      domain keyword in their names (`auth.ts`, `auth-service.ts` -> Auth).
 *
 * Every decision is recorded as a note on the module and given a confidence
 * score, because clustering is the one part of analysis that is genuinely a
 * guess. An LLM can refine the result afterwards (see `src/core/ai`), but it
 * never replaces the file-to-module mapping produced here.
 */

import { humanizeName, slugify, uniqueId } from '../../shared/util/id'
import { basename, dirname, isWithin, join, segments } from '../../shared/util/paths'
import type { FileAnalysis } from './languages'
import { EVIDENCE_WEIGHTS, primaryTagOfName, scoreTags } from './lexicon'

export interface ModuleDraft {
  id: string
  name: string
  /** Project-relative POSIX directory, or `null` for keyword-derived groups. */
  directory: string | null
  files: string[]
  tags: string[]
  confidence: number
  notes: string[]
}

export interface ClusterOptions {
  sourceRoots: string[]
  /** A directory with more files than this is a candidate for splitting. */
  splitThreshold?: number
  /** A subdirectory needs at least this many files to become its own module. */
  minSubdirectoryFiles?: number
}

const DEFAULT_SPLIT_THRESHOLD = 14
const DEFAULT_MIN_SUBDIR_FILES = 2

/** The source root that owns a file; longest match wins, `''` matches all. */
function rootFor(file: string, sourceRoots: string[]): string {
  const matches = sourceRoots
    .filter((r) => isWithin(r, file))
    .sort((a, b) => b.length - a.length)
  return matches[0] ?? ''
}

/** First-level bucket for a file: `src/auth/login.ts` under `src` -> `src/auth`. */
function initialBucket(file: string, root: string): string {
  const rest = root === '' ? file : file.slice(root.length + 1)
  const parts = segments(rest)
  if (parts.length <= 1) return root
  return join(root, parts[0])
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return map
}

/** Second-level split of an oversized bucket. */
function splitBucketBySubdirectory(
  bucket: string,
  files: string[],
  minSubdirFiles: number
): Map<string, string[]> | null {
  const sub = groupBy(files, (file) => {
    const rest = bucket === '' ? file : file.slice(bucket.length + 1)
    const parts = segments(rest)
    return parts.length <= 1 ? bucket : join(bucket, parts[0])
  })

  const viable = [...sub.entries()].filter(
    ([key, list]) => key !== bucket && list.length >= minSubdirFiles
  )
  if (viable.length < 2) return null
  return sub
}

/** Keyword split for a large flat directory with no useful subdirectories. */
function splitBucketByKeyword(
  files: string[],
  minGroupFiles: number
): Map<string, string[]> | null {
  const grouped = groupBy(files, (file) => {
    const tag = primaryTagOfName(basename(file))
    return tag ?? '__core__'
  })
  const viable = [...grouped.entries()].filter(
    ([tag, list]) => tag !== '__core__' && list.length >= minGroupFiles
  )
  if (viable.length < 2) return null
  return grouped
}

const ENTRY_FILE_NAMES = [
  'index',
  'main',
  'app',
  'server',
  'cli',
  'bootstrap',
  'entry'
]

function isEntryFile(file: string): boolean {
  const name = basename(file).replace(/\.[^.]+$/, '').toLowerCase()
  return ENTRY_FILE_NAMES.includes(name)
}

function nameForBucket(
  bucket: string,
  root: string,
  files: string[],
  projectName: string
): string {
  if (bucket === root) {
    // Files sitting directly in the source root.
    if (files.every(isEntryFile) || files.length <= 2) return 'Entry Point'
    return root === '' ? `${humanizeName(projectName)} Root` : humanizeName(basename(root))
  }
  return humanizeName(basename(bucket))
}

export interface ClusterResult {
  modules: ModuleDraft[]
  /** Files the clusterer refused to place (should be empty in practice). */
  unassigned: string[]
}

export function clusterFiles(
  analyses: FileAnalysis[],
  projectName: string,
  options: ClusterOptions
): ClusterResult {
  const splitThreshold = options.splitThreshold ?? DEFAULT_SPLIT_THRESHOLD
  const minSubdirFiles = options.minSubdirectoryFiles ?? DEFAULT_MIN_SUBDIR_FILES
  const sourceRoots = options.sourceRoots.length > 0 ? options.sourceRoots : ['']

  const byRoot = groupBy(analyses, (a) => rootFor(a.path, sourceRoots))

  const drafts: ModuleDraft[] = []
  const takenIds = new Set<string>()
  const unassigned: string[] = []

  for (const root of [...byRoot.keys()].sort()) {
    const rootFiles = byRoot.get(root)!
    const buckets = groupBy(rootFiles, (a) => initialBucket(a.path, root))

    // Decide the final buckets for this root, splitting oversized ones.
    const finalBuckets = new Map<string, { files: string[]; note: string; directory: string | null }>()

    for (const [bucket, bucketAnalyses] of [...buckets.entries()].sort()) {
      const files = bucketAnalyses.map((a) => a.path).sort()

      if (files.length <= splitThreshold) {
        finalBuckets.set(bucket, {
          files,
          directory: bucket,
          note: `Derived from the directory ${bucket === '' ? '(project root)' : bucket}.`
        })
        continue
      }

      const bySubdir = splitBucketBySubdirectory(bucket, files, minSubdirFiles)
      if (bySubdir) {
        for (const [sub, list] of [...bySubdir.entries()].sort()) {
          finalBuckets.set(sub, {
            files: [...list].sort(),
            directory: sub,
            note:
              sub === bucket
                ? `${bucket} held ${files.length} files, so its subdirectories became their own modules; these files sit directly in ${bucket}.`
                : `Split out of ${bucket}, which held ${files.length} files.`
          })
        }
        continue
      }

      const byKeyword = splitBucketByKeyword(files, minSubdirFiles)
      if (byKeyword) {
        for (const [tag, list] of [...byKeyword.entries()].sort()) {
          const key = tag === '__core__' ? bucket : `${bucket}#${tag}`
          finalBuckets.set(key, {
            files: [...list].sort(),
            // Keyword groups are not directory-backed: the files stay put.
            directory: tag === '__core__' ? bucket : null,
            note:
              tag === '__core__'
                ? `Remaining files in the flat directory ${bucket}.`
                : `Grouped by the "${tag}" keyword in their file names, because ${bucket} is a flat directory with ${files.length} files.`
          })
        }
        continue
      }

      finalBuckets.set(bucket, {
        files,
        directory: bucket,
        note: `Derived from the directory ${bucket === '' ? '(project root)' : bucket}; it is large (${files.length} files) but has no clear internal split.`
      })
    }

    for (const [bucket, info] of [...finalBuckets.entries()].sort()) {
      if (info.files.length === 0) continue

      const bucketAnalyses = rootFiles.filter((a) => info.files.includes(a.path))
      const symbolNames = bucketAnalyses.flatMap((a) =>
        a.symbols.filter((s) => s.exported).map((s) => s.name)
      )
      const tags = scoreTags([
        { text: bucket.replace('#', ' '), weight: EVIDENCE_WEIGHTS.path },
        ...info.files.map((f) => ({
          text: basename(f),
          weight: EVIDENCE_WEIGHTS.fileName
        })),
        ...symbolNames.map((n) => ({ text: n, weight: EVIDENCE_WEIGHTS.symbol }))
      ])
        .slice(0, 3)
        .map((t) => t.tag)

      const displayName =
        bucket.includes('#')
          ? humanizeName(bucket.split('#')[1])
          : nameForBucket(bucket, root, info.files, projectName)

      const baseId = slugify(
        bucket === '' || bucket === root ? displayName : bucket.replace(/[/#]/g, '-')
      )
      const id = uniqueId(baseId, takenIds)
      takenIds.add(id)

      // Single-file modules are legitimate but weakly evidenced.
      const confidence =
        info.files.length >= 3 ? 0.8 : info.files.length === 2 ? 0.7 : 0.55

      drafts.push({
        id,
        name: displayName,
        directory: info.directory,
        files: info.files,
        tags,
        confidence,
        notes: [info.note]
      })
    }
  }

  // Safety net: nothing should slip through, but if it does, say so.
  const placed = new Set(drafts.flatMap((d) => d.files))
  for (const a of analyses) {
    if (!placed.has(a.path)) unassigned.push(a.path)
  }

  return { modules: drafts.sort((a, b) => a.id.localeCompare(b.id)), unassigned }
}

/**
 * Directory a module should own, used when the GUI creates a new module.
 * Picks a sibling of the existing modules' common parent so new code lands
 * where the project already keeps its code.
 */
export function suggestDirectoryForNewModule(
  existingDirectories: (string | null)[],
  moduleName: string
): string {
  const dirs = existingDirectories.filter((d): d is string => d !== null && d !== '')
  const slug = slugify(moduleName)
  if (dirs.length === 0) return join('src', slug)

  // The most common parent directory among existing modules.
  const parents = groupBy(dirs, (d) => dirname(d))
  const ranked = [...parents.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
  )
  const parent = ranked[0][0]
  return join(parent, slug)
}
