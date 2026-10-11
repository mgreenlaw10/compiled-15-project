/**
 * Collaborative workspaces: recognising, initializing and joining one.
 *
 * A workspace is just a Git repository plus a `collab-state` branch. There is
 * no server to register with and no database to provision, so "joining" is
 * cloning the repository and announcing yourself on that branch.
 *
 * Local-only projects keep working exactly as before: everything here is opt-in
 * and nothing calls it unless the user asks for collaboration.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  DEFAULT_COLLAB_SETTINGS,
  emptyProjectState,
  initialRevision,
  type CollabProject,
  type CollabSettings,
  type ProjectState
} from '../../shared/collab'
import type { ChannelLogger } from '../logger'
import { Git } from '../git/git'
import { COLLAB_BRANCH, serializeState } from './layout'

/** What we can tell about a directory without the user configuring anything. */
export interface WorkspaceInfo {
  root: string
  isGitRepository: boolean
  remoteUrl: string | null
  currentBranch: string | null
  headCommit: string | null
  /** `true` when a coordination branch exists locally or on the remote. */
  collaborationInitialized: boolean
  /** Uncommitted changes in the user's working tree. */
  dirtyFileCount: number
  /** Git identity, for attribution. */
  identity: { name: string; email: string }
}

export async function inspectWorkspace(root: string): Promise<WorkspaceInfo> {
  const isRepo = await Git.isRepository(root)
  if (!isRepo) {
    return {
      root,
      isGitRepository: false,
      remoteUrl: null,
      currentBranch: null,
      headCommit: null,
      collaborationInitialized: false,
      dirtyFileCount: 0,
      identity: { name: 'Unknown', email: 'unknown@localhost' }
    }
  }

  const git = new Git(root)
  const [remoteUrl, currentBranch, headCommit, identity, status] = await Promise.all([
    git.remoteUrl(),
    git.currentBranch(),
    git.headCommit(),
    git.identity(),
    git.status()
  ])

  const localBranch = await git.branchExists(COLLAB_BRANCH)
  const remoteBranch = await git.remoteBranchExists(COLLAB_BRANCH)

  return {
    root: await git.repositoryRoot(),
    isGitRepository: true,
    remoteUrl,
    currentBranch,
    headCommit,
    collaborationInitialized: localBranch || remoteBranch,
    dirtyFileCount: status.length,
    identity
  }
}

/**
 * This install's stable developer id.
 *
 * Derived from a random id cached in the user data directory rather than from
 * the Git email, so the same person on two machines shows up as two
 * participants — which is what you want, because each machine is a separate
 * execution host. Kept out of the repository: it is per-install state.
 */
export async function loadOrCreateIdentity(
  userDataDir: string,
  git: Git
): Promise<{ developerId: string; hostId: string; displayName: string }> {
  const file = path.join(userDataDir, 'collab-identity.json')
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as {
      developerId?: string
      hostId?: string
    }
    if (parsed.developerId && parsed.hostId) {
      const identity = await git.identity()
      return {
        developerId: parsed.developerId,
        hostId: parsed.hostId,
        displayName: identity.name
      }
    }
  } catch {
    // No identity yet.
  }

  const identity = await git.identity()
  const slug =
    identity.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'dev'
  const created = {
    developerId: `${slug}-${randomUUID().slice(0, 8)}`,
    hostId: randomUUID()
  }
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(created, null, 2)}\n`, 'utf8')
  return { ...created, displayName: identity.name }
}

export interface InitializeOptions {
  root: string
  developerId: string
  projectName: string
  /** Branch task work is integrated into. Defaults to the current branch. */
  integratedBranch?: string
  settings?: Partial<CollabSettings>
  /** Added as `origin` when the repository has no remote yet. */
  remoteUrl?: string
  logger: ChannelLogger
  /** `false` to create the branch locally without publishing it. */
  push?: boolean
}

/**
 * Creates the coordination branch.
 *
 * The branch is an orphan root commit holding only metadata, written without
 * checking anything out, so initializing collaboration cannot touch the user's
 * files. Safe to call on a repository that already has one: it refuses rather
 * than overwriting someone else's project identity.
 */
export async function initializeCollaboration(
  options: InitializeOptions
): Promise<{ project: CollabProject; commit: string; pushed: boolean }> {
  const git = new Git(options.root)
  if (!(await Git.isRepository(options.root))) {
    throw new Error(
      `${options.root} is not a Git repository. Collaboration needs one, because Git is the synchronization mechanism.`
    )
  }

  if (options.remoteUrl && !(await git.hasRemote())) {
    await git.addRemote('origin', options.remoteUrl)
  }

  // Refuse to clobber: if a coordination branch exists anywhere, the project
  // has already been initialized and the user wants `joinCollaboration`.
  if (
    (await git.branchExists(COLLAB_BRANCH)) ||
    (await git.remoteBranchExists(COLLAB_BRANCH))
  ) {
    throw new Error(
      `This repository already has a "${COLLAB_BRANCH}" branch. Join the existing collaborative project instead of re-initializing it.`
    )
  }

  const integratedBranch =
    options.integratedBranch ?? (await git.currentBranch()) ?? 'main'

  const project: CollabProject = {
    id: randomUUID(),
    name: options.projectName,
    repositoryUrl: await git.remoteUrl(),
    integratedBranch,
    architectureVersion: 0,
    settings: { ...DEFAULT_COLLAB_SETTINGS, ...options.settings },
    ...initialRevision(options.developerId)
  }

  const state: ProjectState = emptyProjectState(project)
  state.events.push({
    id: `ev_${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    kind: 'project_initialized',
    actor: options.developerId,
    message: `initialized collaboration on "${project.name}"`
  })

  const commit = await git.writeBranchFiles({
    branch: COLLAB_BRANCH,
    files: serializeState(state),
    message: `collab: initialize coordination for ${project.name}`,
    parent: null
  })

  let pushed = false
  if (options.push !== false && (await git.hasRemote())) {
    try {
      await git.push('origin', `refs/heads/${COLLAB_BRANCH}:refs/heads/${COLLAB_BRANCH}`)
      pushed = true
    } catch (error) {
      // The branch exists locally and will publish on the next sync. Saying it
      // was shared when it was not would be worse than saying it was not.
      options.logger.warn(
        'The coordination branch was created locally but could not be pushed yet',
        (error as Error).message
      )
    }
  }

  options.logger.success(
    `Initialized collaboration on "${project.name}" (${COLLAB_BRANCH}${pushed ? ', pushed' : ', not yet pushed'})`
  )
  return { project, commit, pushed }
}

/**
 * Attaches to a project someone else initialized.
 *
 * Only fetches: the local coordination branch is created pointing at whatever
 * the remote published, and the provider takes over from there.
 */
export async function joinCollaboration(options: {
  root: string
  logger: ChannelLogger
}): Promise<{ commit: string }> {
  const git = new Git(options.root)
  if (!(await git.hasRemote())) {
    throw new Error(
      'This repository has no remote, so there is nothing to join. Add a remote, or initialize collaboration here instead.'
    )
  }

  // A remote with no coordination branch makes this refspec match nothing,
  // which Git reports as an error. That is a "not set up yet", not a failure,
  // so the ref is checked afterwards rather than trusting the exit code.
  await git.fetch(
    'origin',
    [`+refs/heads/${COLLAB_BRANCH}:refs/remotes/origin/${COLLAB_BRANCH}`],
    { allowFailure: true }
  )
  const remoteCommit = await git.resolveRef(`refs/remotes/origin/${COLLAB_BRANCH}`)
  if (!remoteCommit) {
    throw new Error(
      `The remote has no "${COLLAB_BRANCH}" branch, so this project is not set up for collaboration yet. Initialize it instead.`
    )
  }

  if (!(await git.branchExists(COLLAB_BRANCH))) {
    await git.updateRef(`refs/heads/${COLLAB_BRANCH}`, remoteCommit)
  }
  options.logger.success(`Joined the collaborative project at ${remoteCommit.slice(0, 8)}`)
  return { commit: remoteCommit }
}

/** Clones a remote so a second developer can join it. */
export async function cloneForCollaboration(options: {
  url: string
  destination: string
  logger: ChannelLogger
}): Promise<{ root: string }> {
  options.logger.info(`Cloning ${options.url}`)
  const git = await Git.clone(options.url, options.destination)
  const root = await git.repositoryRoot()
  options.logger.success(`Cloned into ${root}`)
  return { root }
}

/** Where task worktrees go. Outside the repository, so they are never scanned. */
export function worktreeRootFor(repoRoot: string): string {
  return path.join(
    path.dirname(repoRoot),
    `${path.basename(repoRoot)}-agent-worktrees`
  )
}

/** A scratch directory for trial merges, on the same volume where possible. */
export async function integrationScratchDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-integrate-'))
}
