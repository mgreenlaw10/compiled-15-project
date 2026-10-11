/**
 * Task worktrees.
 *
 * Every task gets its own Git worktree and branch, so parallel agents edit real
 * source files without sharing a checkout. That is what makes the parallelism
 * genuine rather than simulated: two agents running at once are two processes
 * writing two directories, each on its own branch forked from the integrated
 * commit.
 *
 *     project/                     the user's checkout, never touched by agents
 *     project-agent-worktrees/
 *       task-101/                  branch agent/task-101
 *       task-102/                  branch agent/task-102
 *
 * Worktree paths are local and deliberately never published to the coordination
 * branch: another machine cannot use them, and they would leak directory
 * layouts into a shared repository.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ChannelLogger } from '../logger'
import { Git } from '../git/git'
import { worktreeRootFor } from './workspace'

/** Branch name for a task. Grouped under `agent/` so they are easy to spot. */
export function branchForTask(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '-')
  return `agent/${safe}`
}

export interface TaskWorkspace {
  taskId: string
  /** Absolute path of the worktree. Local only. */
  path: string
  branch: string
  baseCommit: string
  git: Git
}

export interface PrepareOptions {
  repoRoot: string
  taskId: string
  /** Commit on the integrated branch to fork from. */
  baseCommit: string
  logger: ChannelLogger
}

/**
 * Creates (or re-attaches to) the worktree for a task.
 *
 * Idempotent: re-preparing an existing task returns the worktree it already
 * has rather than destroying work in progress. An agent that crashed and is
 * being restarted must find its files where it left them.
 */
export async function prepareTaskWorkspace(
  options: PrepareOptions
): Promise<TaskWorkspace> {
  const repo = new Git(options.repoRoot)
  const branch = branchForTask(options.taskId)
  const worktreePath = path.join(worktreeRootFor(options.repoRoot), options.taskId)

  const existing = (await repo.worktrees()).find(
    (worktree) => path.resolve(worktree.path) === path.resolve(worktreePath)
  )

  if (existing) {
    options.logger.debug(`Re-using the existing worktree for ${options.taskId}`)
    return {
      taskId: options.taskId,
      path: worktreePath,
      branch: existing.branch ?? branch,
      baseCommit: options.baseCommit,
      git: new Git(worktreePath)
    }
  }

  // A directory left behind by a pruned worktree would make `worktree add`
  // fail with a confusing message.
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {})

  await repo.addWorktree({
    worktreePath,
    branch,
    baseCommit: options.baseCommit
  })
  options.logger.info(
    `Prepared an isolated worktree for ${options.taskId} on ${branch}`,
    worktreePath
  )

  return {
    taskId: options.taskId,
    path: worktreePath,
    branch,
    baseCommit: options.baseCommit,
    git: new Git(worktreePath)
  }
}

/**
 * Removes a task's worktree.
 *
 * The branch is kept: it holds the task's commits, and discarding work because
 * a worktree was tidied up would be unforgivable. Only the checkout goes.
 */
export async function discardTaskWorkspace(options: {
  repoRoot: string
  taskId: string
  logger: ChannelLogger
}): Promise<void> {
  const repo = new Git(options.repoRoot)
  const worktreePath = path.join(worktreeRootFor(options.repoRoot), options.taskId)
  await repo.removeWorktree(worktreePath, true)
  options.logger.debug(`Removed the worktree for ${options.taskId}; its branch is kept`)
}

/** Worktrees Cartograph created, with the task each belongs to. */
export async function listTaskWorkspaces(
  repoRoot: string
): Promise<{ taskId: string; path: string; branch: string | null; head: string }[]> {
  const repo = new Git(repoRoot)
  const root = path.resolve(worktreeRootFor(repoRoot))

  return (await repo.worktrees())
    .filter((worktree) => path.resolve(worktree.path).startsWith(root))
    .map((worktree) => ({
      taskId: path.basename(worktree.path),
      path: worktree.path,
      branch: worktree.branch,
      head: worktree.head
    }))
}

/** Commits whatever the agent changed, on the task's own branch. */
export async function commitTaskWork(options: {
  workspace: TaskWorkspace
  message: string
  author?: { name: string; email: string }
}): Promise<string | null> {
  return options.workspace.git.commitAll(options.message, options.author)
}

/** Files the task changed relative to the commit it forked from. */
export async function taskChangedPaths(
  workspace: TaskWorkspace
): Promise<string[]> {
  const head = await workspace.git.headCommit()
  if (!head) return []

  const base =
    (await workspace.git.mergeBase(workspace.baseCommit, head)) ?? workspace.baseCommit
  const committed = await workspace.git.changedFiles(base, head)

  // Uncommitted work counts too: an agent that stopped mid-task has still
  // changed the files, and the scope check must see them.
  const dirty = (await workspace.git.status()).map((entry) => entry.path)
  return [...new Set([...committed, ...dirty])]
}
