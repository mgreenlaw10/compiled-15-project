/**
 * The integration coordinator.
 *
 * Agents never push to the integrated branch. They commit to their own task
 * branch and submit it; this module decides whether the result can safely join
 * the canonical line, and says why when it cannot.
 *
 * The order matters and is deliberate:
 *
 *   1. Check the real diff against the task's write scope. An agent's account
 *      of what it changed is not evidence.
 *   2. Try the merge *without touching any working tree* (`merge-tree`), so a
 *      rejected integration cannot leave anyone's checkout conflicted.
 *   3. Analyze architecture: what public surface changed, and who depends on it.
 *   4. Only then, if asked and permitted, run validation commands.
 *   5. Publish with a remote ref check and a non-force push, so two coordinators
 *      cannot silently overwrite each other.
 *
 * Git-level merge success does not mean the result is correct, and this module
 * never claims it does: a clean merge with an interface change still reports
 * the incompatibility.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ArchitectureGraph } from '../../shared/types/architecture'
import type {
  IntegrationConflict,
  IntegrationStatus,
  Task,
  ValidationOutcome
} from '../../shared/collab'
import type { ChannelLogger } from '../logger'
import { Git, GitError } from '../git/git'
import { detectConflicts, type ChangeSetSummary } from './conflicts'
import { checkScope, describeScopeCheck } from './scope'
import { branchForTask } from './tasks'

export interface IntegrationInput {
  repoRoot: string
  task: Task
  /** The branch work is integrated into, e.g. `main`. */
  targetBranch: string
  /** The graph of the integrated branch, for dependency resolution. */
  baseGraph: ArchitectureGraph
  /** The graph as analyzed on the task branch, when available. */
  taskGraph?: ArchitectureGraph | null
  /** Other in-flight tasks, for cross-task warnings. */
  others?: ChangeSetSummary[]
  logger: ChannelLogger
  remote?: string
}

export interface IntegrationAssessment {
  status: IntegrationStatus
  conflicts: IntegrationConflict[]
  changedPaths: string[]
  outOfScopePaths: string[]
  sourceCommit: string
  targetCommit: string
  /** `true` when Git alone could combine the branches. */
  mergesCleanly: boolean
  scopeSummary: string
  note: string | null
}

/**
 * Works out whether a task's branch can be integrated. Changes nothing.
 *
 * Safe to call repeatedly and safe to call on someone else's task: it reads
 * refs and computes a merge in the object database, and writes no ref, no
 * index and no file.
 */
export async function assessIntegration(
  input: IntegrationInput
): Promise<IntegrationAssessment> {
  const git = new Git(input.repoRoot)
  const log = input.logger
  const branch = input.task.branch ?? branchForTask(input.task.id)

  const sourceCommit = await git.resolveRef(branch)
  const targetCommit = await git.resolveRef(input.targetBranch)

  if (!sourceCommit) {
    return {
      status: 'failed',
      conflicts: [],
      changedPaths: [],
      outOfScopePaths: [],
      sourceCommit: '',
      targetCommit: targetCommit ?? '',
      mergesCleanly: false,
      scopeSummary: '',
      note: `The task branch "${branch}" does not exist. Has the agent committed anything?`
    }
  }
  if (!targetCommit) {
    return {
      status: 'failed',
      conflicts: [],
      changedPaths: [],
      outOfScopePaths: [],
      sourceCommit,
      targetCommit: '',
      mergesCleanly: false,
      scopeSummary: '',
      note: `The target branch "${input.targetBranch}" does not exist.`
    }
  }

  const mergeBase = (await git.mergeBase(targetCommit, sourceCommit)) ?? targetCommit
  const changedPaths = await git.changedFiles(mergeBase, sourceCommit)

  // 1. Scope, against the real diff.
  const scope = checkScope(input.baseGraph, input.task.moduleIds, changedPaths)
  const outOfScopePaths = scope.violations
    .filter((violation) => violation.reason !== 'shared_config')
    .map((violation) => violation.path)
  const scopeSummary = describeScopeCheck(scope, input.baseGraph)

  if (outOfScopePaths.length > 0) {
    log.warn(`Task ${input.task.id} changed files outside its modules`, scopeSummary)
  }

  // 2. Trial merge, in the object database only.
  const trial = await git.canMergeCleanly(mergeBase, targetCommit, sourceCommit)

  // 3. Architecture.
  const conflicts = detectConflicts({
    baseGraph: input.baseGraph,
    incoming: {
      taskId: input.task.id,
      moduleIds: input.task.moduleIds,
      changedPaths,
      graph: input.taskGraph ?? null
    },
    others: input.others ?? [],
    gitConflictPaths: trial.clean ? [] : trial.conflictingPaths
  })

  if (outOfScopePaths.length > 0) {
    conflicts.unshift({
      kind: 'file',
      severity: 'warning',
      summary: `${outOfScopePaths.length} file(s) changed outside the task's modules`,
      explanation:
        `${scopeSummary}. Module reservations are advisory, so this was not prevented — ` +
        'it is reported here so a human can decide whether the change belongs.',
      paths: outOfScopePaths,
      affectedModuleIds: [],
      symbolIds: [],
      withTaskIds: []
    })
  }

  const blocking = conflicts.filter((conflict) => conflict.severity === 'blocking')

  return {
    status: blocking.length > 0 ? 'conflicted' : 'ready',
    conflicts,
    changedPaths,
    outOfScopePaths,
    sourceCommit,
    targetCommit,
    mergesCleanly: trial.clean,
    scopeSummary,
    note:
      blocking.length > 0
        ? `${blocking.length} blocking conflict(s) must be resolved before this can be integrated.`
        : null
  }
}

export interface ValidationOptions {
  /** Project-defined commands are only run when the user allows it. */
  allowCommands: boolean
  /** Working directory to validate in. */
  cwd: string
  logger: ChannelLogger
  signal?: AbortSignal
}

/**
 * Runs the project's own checks.
 *
 * Gated behind `allowCommands` and off by default: integrating a branch an
 * agent wrote means running code that an agent wrote, and doing that silently
 * on someone's machine is not acceptable. When it is not allowed, the result
 * says `not_run` — never `passed`.
 */
export async function runValidation(
  options: ValidationOptions
): Promise<ValidationOutcome[]> {
  const outcomes: ValidationOutcome[] = []

  if (!options.allowCommands) {
    return [
      {
        name: 'validation',
        status: 'not_run',
        message:
          'Project commands were not run: validation of agent-generated changes is disabled in collaboration settings.',
        durationMs: 0
      }
    ]
  }

  let scripts: Record<string, string> = {}
  try {
    const raw = await fs.readFile(path.join(options.cwd, 'package.json'), 'utf8')
    scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {}
  } catch {
    return [
      {
        name: 'validation',
        status: 'skipped',
        message: 'No package.json was found, so there are no project checks to run.',
        durationMs: 0
      }
    ]
  }

  const candidates: { name: string; script: string }[] = [
    { name: 'typecheck', script: 'typecheck' },
    { name: 'build', script: 'build' },
    { name: 'test', script: 'test' }
  ]

  for (const candidate of candidates) {
    if (!scripts[candidate.script]) {
      outcomes.push({
        name: candidate.name,
        status: 'skipped',
        message: `The project has no "${candidate.script}" script.`,
        durationMs: 0
      })
      continue
    }

    const started = Date.now()
    try {
      const { runCommand } = await import('./run-command')
      const result = await runCommand({
        command: 'npm',
        args: ['run', candidate.script, '--silent'],
        cwd: options.cwd,
        signal: options.signal
      })
      outcomes.push({
        name: candidate.name,
        status: result.exitCode === 0 ? 'passed' : 'failed',
        message:
          result.exitCode === 0
            ? `npm run ${candidate.script} succeeded.`
            : tail(result.output, 2000),
        durationMs: Date.now() - started
      })
    } catch (error) {
      // "Could not run" is reported distinctly from "ran and failed": they
      // mean different things to whoever reads the report.
      outcomes.push({
        name: candidate.name,
        status: 'not_run',
        message: `Could not run the ${candidate.name} command: ${(error as Error).message}`,
        durationMs: Date.now() - started
      })
    }
  }

  return outcomes
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text
}

export interface MergeOptions {
  repoRoot: string
  task: Task
  targetBranch: string
  logger: ChannelLogger
  remote?: string
  /** `false` to merge locally without publishing. */
  push?: boolean
}

export interface MergeResult {
  ok: boolean
  mergeCommit: string | null
  conflictingPaths: string[]
  pushed: boolean
  note: string
}

/**
 * Merges a task branch into the integrated branch and publishes it.
 *
 * Done in a throwaway worktree rather than in the user's checkout: the user may
 * have uncommitted work, and nothing here is allowed to touch it. The remote is
 * re-checked immediately before pushing, and the push is never forced, so a
 * coordinator that lost a race fails loudly instead of overwriting.
 */
export async function mergeTaskBranch(options: MergeOptions): Promise<MergeResult> {
  const repo = new Git(options.repoRoot)
  const remote = options.remote ?? 'origin'
  const branch = options.task.branch ?? branchForTask(options.task.id)

  const targetBefore = await repo.resolveRef(options.targetBranch)
  if (!targetBefore) {
    return {
      ok: false,
      mergeCommit: null,
      conflictingPaths: [],
      pushed: false,
      note: `The target branch "${options.targetBranch}" does not exist.`
    }
  }

  // A single integration authority for the canonical branch: if the remote has
  // moved since we assessed, we re-assess rather than publishing blind.
  if (await repo.hasRemote(remote)) {
    const remoteHead = await repo.remoteRefCommit(options.targetBranch, remote)
    if (remoteHead && remoteHead !== targetBefore) {
      return {
        ok: false,
        mergeCommit: null,
        conflictingPaths: [],
        pushed: false,
        note: `${remote}/${options.targetBranch} has advanced since this was assessed. Synchronize and re-assess before integrating.`
      }
    }
  }

  const scratch = path.join(
    path.dirname(options.repoRoot),
    `.cartograph-integrate-${options.task.id}`
  )
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})

  try {
    await repo.run(['worktree', 'add', '--detach', scratch, options.targetBranch])
    const work = new Git(scratch)
    // Detached: committing here cannot move anyone's branch by accident.
    await work.run(['checkout', '-B', `integrate/${options.task.id}`, targetBefore])

    const merged = await work.merge(
      branch,
      `Integrate ${options.task.id}: ${options.task.title}`
    )
    if (!merged.ok) {
      return {
        ok: false,
        mergeCommit: null,
        conflictingPaths: merged.conflictingPaths,
        pushed: false,
        note: `Git could not merge ${branch} into ${options.targetBranch} automatically.`
      }
    }

    const mergeCommit = merged.commit
    if (!mergeCommit) {
      return {
        ok: false,
        mergeCommit: null,
        conflictingPaths: [],
        pushed: false,
        note: 'The merge produced no commit.'
      }
    }

    // Move the real branch only once the merge has actually succeeded.
    await repo.updateRef(`refs/heads/${options.targetBranch}`, mergeCommit)

    let pushed = false
    if (options.push !== false && (await repo.hasRemote(remote))) {
      try {
        await repo.push(
          remote,
          `refs/heads/${options.targetBranch}:refs/heads/${options.targetBranch}`
        )
        pushed = true
      } catch (error) {
        if (error instanceof GitError && error.isNonFastForward) {
          // Someone published between our ref check and our push. Put the
          // branch back and report it; overwriting theirs is not an option.
          await repo.updateRef(`refs/heads/${options.targetBranch}`, targetBefore)
          return {
            ok: false,
            mergeCommit: null,
            conflictingPaths: [],
            pushed: false,
            note: `${remote}/${options.targetBranch} advanced while integrating, so the merge was rolled back locally. Synchronize and try again.`
          }
        }
        options.logger.warn(
          'The merge succeeded locally but could not be pushed',
          (error as Error).message
        )
      }
    }

    options.logger.success(
      `Integrated ${options.task.id} into ${options.targetBranch}${pushed ? ' and pushed it' : ' (not pushed)'}`
    )
    return {
      ok: true,
      mergeCommit,
      conflictingPaths: [],
      pushed,
      note: pushed
        ? `Merged into ${options.targetBranch} and published.`
        : `Merged into ${options.targetBranch} locally; it has not been published yet.`
    }
  } finally {
    await repo.removeWorktree(scratch, true)
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}
