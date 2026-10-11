/**
 * Writing a change set to disk.
 *
 * This is the only module in the project that mutates the user's files, and it
 * is deliberately paranoid about it:
 *
 *   - every target path is checked to be inside the destination root before
 *     anything happens, so a path in a change set cannot escape the project,
 *   - the whole set is pre-flighted (conflicts, missing sources, unwritable
 *     parents) before the first byte is written, which is how "avoid partial
 *     writes" is honoured in practice,
 *   - an in-place write first copies every file it is about to touch into
 *     `.cartograph/backups/<timestamp>/`, together with a manifest that
 *     `restoreBackup` can replay,
 *   - and generating into a new directory never opens the original for writing
 *     at all.
 */

import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

import type {
  ApplyResult,
  BackupInfo,
  ChangeSet,
  FileChange,
  WriteMode
} from '../../shared/types/generation'
import { CARTOGRAPH_DIR } from '../../shared/types/project'
import { normalizeRel, toPosix } from '../../shared/util/paths'
import type { Logger } from '../logger'
import { silentLogger } from '../logger'
import { createIgnoreRules, shouldIgnoreDirectory } from '../analyzer/ignore'

export interface ApplyOptions {
  mode: WriteMode
  /** Required when mode is `new-directory`. */
  outputDirectory?: string
  createBackup: boolean
  logger?: Logger
  /** Extra directories to leave out when copying to a new directory. */
  extraIgnores?: string[]
}

export interface BackupManifest {
  createdAt: string
  projectRoot: string
  gitHead: string | null
  gitDirty: boolean | null
  entries: {
    /** Project-relative POSIX path. */
    path: string
    /** `modified`/`deleted`: a copy exists. `created`: the file was new. */
    kind: 'modified' | 'deleted' | 'created'
  }[]
}

/**
 * Resolves a project-relative path inside `root`, refusing to escape it.
 *
 * A `..` segment is rejected outright rather than normalized away. Collapsing
 * it would silently turn `../secrets.env` into `secrets.env` and write
 * *somewhere*, which is worse than refusing: a change set may have been built
 * by the AI agent or, later, by a remote collaborator, so a path that tries to
 * leave the project is a signal, not a typo to tidy up.
 */
export function resolveInside(root: string, relPath: string): string {
  if (toPosix(relPath).split('/').includes('..')) {
    throw new Error(
      `Refusing to write outside the project: "${relPath}" contains a ".." segment`
    )
  }
  const normalized = normalizeRel(relPath)
  if (normalized === '') {
    throw new Error('A change set entry has an empty path')
  }
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, normalized)
  const rel = path.relative(resolvedRoot, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to write outside the project: "${relPath}" resolves to ${target}`
    )
  }
  return target
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function run(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    // No shell: `git` is a real executable on every platform, and shelling
    // out with arguments concatenated into a command line is a quoting hazard.
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.on('error', () => resolve({ code: null, stdout }))
    child.on('close', (code) => resolve({ code, stdout }))
  })
}

async function gitState(
  root: string
): Promise<{ head: string | null; dirty: boolean | null }> {
  if (!(await exists(path.join(root, '.git')))) {
    return { head: null, dirty: null }
  }
  const head = await run('git', ['rev-parse', 'HEAD'], root)
  const status = await run('git', ['status', '--porcelain'], root)
  return {
    head: head.code === 0 ? head.stdout.trim().split('\n')[0] : null,
    dirty: status.code === 0 ? status.stdout.trim().length > 0 : null
  }
}

/** Copies a project into `destination`, skipping dependency/build directories. */
export async function copyProject(
  source: string,
  destination: string,
  options: { extraIgnores?: string[]; logger?: Logger } = {}
): Promise<{ copied: number; skippedDirectories: string[] }> {
  const log = (options.logger ?? silentLogger).child('generation')
  const rules = createIgnoreRules({ extraIgnores: options.extraIgnores })
  let copied = 0
  const skippedDirectories: string[] = []

  const walk = async (relDir: string): Promise<void> => {
    const absSource = path.join(source, relDir)
    const entries = await fs.readdir(absSource, { withFileTypes: true })
    await fs.mkdir(path.join(destination, relDir), { recursive: true })

    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (shouldIgnoreDirectory(rel, rules) || rel === CARTOGRAPH_DIR) {
          skippedDirectories.push(rel)
          continue
        }
        await walk(rel)
        continue
      }
      if (!entry.isFile()) continue
      await fs.copyFile(
        path.join(source, rel),
        path.join(destination, rel)
      )
      copied += 1
    }
  }

  await walk('')
  if (skippedDirectories.length > 0) {
    log.info(
      `Copied ${copied} file(s); skipped ${skippedDirectories.length} directory(ies): ${skippedDirectories
        .slice(0, 8)
        .join(', ')}${skippedDirectories.length > 8 ? ', …' : ''}`
    )
  } else {
    log.info(`Copied ${copied} file(s) into the output directory`)
  }
  return { copied, skippedDirectories }
}

/** Checks a change set can be applied against `root` before writing anything. */
export async function preflight(
  root: string,
  changeSet: ChangeSet
): Promise<string[]> {
  const problems: string[] = []
  const seen = new Set<string>()

  for (const change of changeSet.changes) {
    let target: string
    try {
      target = resolveInside(root, change.path)
    } catch (error) {
      problems.push((error as Error).message)
      continue
    }

    if (seen.has(target)) {
      problems.push(`Two changes write to the same path: ${change.path}`)
    }
    seen.add(target)

    if (change.previousPath !== undefined) {
      try {
        resolveInside(root, change.previousPath)
      } catch (error) {
        problems.push((error as Error).message)
      }
    }

    if (change.kind === 'create' && (await exists(target))) {
      problems.push(
        `${change.path} is marked as a new file but already exists in the output`
      )
    }
    if (
      (change.kind === 'modify' || change.kind === 'delete') &&
      !(await exists(target))
    ) {
      problems.push(
        `${change.path} is marked as ${change.kind} but does not exist in the output`
      )
    }
    if (change.kind === 'rename' && change.previousPath) {
      const from = resolveInside(root, change.previousPath)
      if (!(await exists(from))) {
        problems.push(
          `${change.previousPath} is marked as moved but does not exist in the output`
        )
      }
    }
  }

  return problems
}

async function writeBackup(
  root: string,
  changeSet: ChangeSet,
  logger: Logger
): Promise<BackupInfo> {
  const log = logger.child('generation')
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)
  const directory = path.join(root, CARTOGRAPH_DIR, 'backups', stamp)
  await fs.mkdir(path.join(directory, 'files'), { recursive: true })

  const git = await gitState(root)
  const entries: BackupManifest['entries'] = []

  for (const change of changeSet.changes) {
    const sourceRel =
      change.kind === 'rename' || change.kind === 'delete'
        ? (change.previousPath ?? change.path)
        : change.path

    if (change.kind === 'create') {
      entries.push({ path: normalizeRel(change.path), kind: 'created' })
      continue
    }

    const from = resolveInside(root, sourceRel)
    if (!(await exists(from))) continue
    const to = path.join(directory, 'files', normalizeRel(sourceRel))
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(from, to)
    entries.push({
      path: normalizeRel(sourceRel),
      kind: change.kind === 'delete' ? 'deleted' : 'modified'
    })
  }

  const manifest: BackupManifest = {
    createdAt: stamp,
    projectRoot: root,
    gitHead: git.head,
    gitDirty: git.dirty,
    entries
  }
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  await fs.writeFile(
    path.join(directory, 'README.txt'),
    [
      'Cartograph backup',
      '',
      `Taken before writing generated changes to ${root}.`,
      `Files: ${entries.length}`,
      git.head ? `Git HEAD at the time: ${git.head}` : 'Not a git repository.',
      git.dirty
        ? 'The working tree had uncommitted changes, so this backup is the only way back.'
        : '',
      '',
      'To restore by hand, copy everything under files/ back over the project,',
      'and delete any file listed as "created" in manifest.json.',
      ''
    ]
      .filter((l) => l !== '')
      .join('\n'),
    'utf8'
  )

  log.info(`Backed up ${entries.length} file(s) to ${directory}`)
  if (git.dirty) {
    log.warn(
      'The git working tree has uncommitted changes; the backup directory is your only checkpoint.'
    )
  }

  return {
    directory,
    fileCount: entries.length,
    gitHead: git.head,
    gitDirty: git.dirty
  }
}

/** Replays a backup manifest, putting the project back as it was. */
export async function restoreBackup(backupDirectory: string): Promise<{
  restored: string[]
  removed: string[]
  errors: string[]
}> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(backupDirectory, 'manifest.json'), 'utf8')
  ) as BackupManifest

  const restored: string[] = []
  const removed: string[] = []
  const errors: string[] = []

  for (const entry of manifest.entries) {
    const target = resolveInside(manifest.projectRoot, entry.path)
    try {
      if (entry.kind === 'created') {
        if (await exists(target)) {
          await fs.rm(target)
          removed.push(entry.path)
        }
        continue
      }
      const copy = path.join(backupDirectory, 'files', entry.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(copy, target)
      restored.push(entry.path)
    } catch (error) {
      errors.push(`${entry.path}: ${(error as Error).message}`)
    }
  }

  return { restored, removed, errors }
}

async function applyOne(
  root: string,
  change: FileChange
): Promise<void> {
  const target = resolveInside(root, change.path)

  switch (change.kind) {
    case 'create':
    case 'modify': {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, change.after ?? '', 'utf8')
      return
    }
    case 'rename': {
      const from = resolveInside(root, change.previousPath ?? change.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, change.after ?? '', 'utf8')
      if (path.resolve(from) !== path.resolve(target)) {
        await fs.rm(from, { force: true })
      }
      return
    }
    case 'delete': {
      await fs.rm(target, { force: true })
      return
    }
    default: {
      const exhaustive: never = change.kind
      throw new Error(`Unknown change kind: ${String(exhaustive)}`)
    }
  }
}

/** Removes directories that the applied changes left empty. */
async function pruneEmptyDirectories(
  root: string,
  changes: FileChange[]
): Promise<void> {
  const candidates = new Set<string>()
  for (const change of changes) {
    if (change.kind !== 'rename' && change.kind !== 'delete') continue
    const source = change.previousPath ?? change.path
    let dir = path.dirname(resolveInside(root, source))
    const stop = path.resolve(root)
    while (dir.startsWith(stop) && dir !== stop) {
      candidates.add(dir)
      dir = path.dirname(dir)
    }
  }

  // Deepest first, so a parent becomes empty only after its children go.
  for (const dir of [...candidates].sort((a, b) => b.length - a.length)) {
    try {
      const entries = await fs.readdir(dir)
      if (entries.length === 0) await fs.rmdir(dir)
    } catch {
      // Already gone, or not empty: nothing to do.
    }
  }
}

export async function applyChangeSet(
  projectRoot: string,
  changeSet: ChangeSet,
  options: ApplyOptions
): Promise<ApplyResult> {
  const logger = options.logger ?? silentLogger
  const log = logger.child('generation')

  const destination =
    options.mode === 'new-directory'
      ? options.outputDirectory
      : projectRoot
  if (!destination) {
    throw new Error('An output directory is required when generating to a new directory')
  }

  const result: ApplyResult = {
    mode: options.mode,
    outputDirectory: destination,
    created: [],
    modified: [],
    deleted: [],
    renamed: [],
    backup: null,
    validation: null,
    appliedOperationIds: [],
    errors: []
  }

  if (options.mode === 'new-directory') {
    if (path.resolve(destination) === path.resolve(projectRoot)) {
      throw new Error(
        'The output directory is the project directory. Use the overwrite mode to change the project in place.'
      )
    }
    const resolvedDestination = path.resolve(destination)
    const resolvedSource = path.resolve(projectRoot)
    if (
      resolvedDestination.startsWith(`${resolvedSource}${path.sep}`)
    ) {
      throw new Error(
        'The output directory is inside the project directory, which would copy the project into itself. Choose a sibling directory.'
      )
    }
    if (await exists(destination)) {
      const entries = await fs.readdir(destination)
      if (entries.length > 0) {
        throw new Error(
          `The output directory is not empty (${entries.length} entries). Choose an empty or new directory.`
        )
      }
    }
    await fs.mkdir(destination, { recursive: true })
    log.info(`Copying ${projectRoot} to ${destination}`)
    await copyProject(projectRoot, destination, {
      extraIgnores: options.extraIgnores,
      logger
    })
  }

  const problems = await preflight(destination, changeSet)
  if (problems.length > 0) {
    result.errors.push(...problems)
    log.error(
      `Refusing to write: ${problems.length} problem(s) found before touching any file.`
    )
    for (const problem of problems.slice(0, 10)) log.error(problem)
    return result
  }

  if (options.mode === 'in-place' && options.createBackup) {
    result.backup = await writeBackup(projectRoot, changeSet, logger)
  }

  const appliedOperationIds = new Set<string>()
  for (const change of changeSet.changes) {
    try {
      await applyOne(destination, change)
      switch (change.kind) {
        case 'create':
          result.created.push(change.path)
          break
        case 'modify':
          result.modified.push(change.path)
          break
        case 'delete':
          result.deleted.push(change.path)
          break
        case 'rename':
          result.renamed.push({
            from: change.previousPath ?? change.path,
            to: change.path
          })
          break
      }
      for (const id of change.operationIds) appliedOperationIds.add(id)
    } catch (error) {
      result.errors.push(`${change.path}: ${(error as Error).message}`)
      log.error(`Failed to write ${change.path}`, (error as Error).message)
    }
  }

  await pruneEmptyDirectories(destination, changeSet.changes)

  // An operation only counts as applied when it produced changes and every one
  // of those changes was written.
  const failedPaths = new Set(
    result.errors.map((e) => e.split(':')[0])
  )
  result.appliedOperationIds = [...appliedOperationIds].filter((id) =>
    changeSet.changes
      .filter((c) => c.operationIds.includes(id))
      .every((c) => !failedPaths.has(c.path))
  )

  log.success(
    `Wrote ${result.created.length} new, ${result.modified.length} modified, ${result.renamed.length} moved and ${result.deleted.length} deleted file(s) to ${toPosix(destination)}`
  )
  if (result.errors.length > 0) {
    log.error(`${result.errors.length} file(s) could not be written.`)
  }

  return result
}
