/**
 * Git, as a typed API.
 *
 * Every Git invocation in Cartograph goes through here. Nothing above this
 * layer builds an argv, and nothing in the renderer touches Git at all — the
 * renderer only ever sees the collaboration model over IPC.
 *
 * Two rules this module enforces by construction:
 *
 *   - **No force pushes and no history rewriting.** `push` refuses `--force`.
 *     Synchronization resolves divergence by merging state and retrying, never
 *     by overwriting what someone else published.
 *   - **No clobbering uncommitted work.** Reads and writes of the coordination
 *     branch never check it out, so they cannot touch the user's working tree.
 *     That is what `writeBranchFiles` is for.
 *
 * Arguments are passed as an argv array to `execFile`, never through a shell,
 * so a branch or path containing shell metacharacters is data rather than code.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 60_000
/** Generous: a clone or a fetch of a large repository is slow but not hung. */
const NETWORK_TIMEOUT_MS = 10 * 60 * 1000
const MAX_BUFFER = 64 * 1024 * 1024

export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'GitError'
  }

  /** `true` when a push was rejected because the remote moved on. */
  get isNonFastForward(): boolean {
    const text = this.stderr.toLowerCase()
    return (
      text.includes('non-fast-forward') ||
      text.includes('fetch first') ||
      text.includes('rejected') ||
      text.includes('stale info')
    )
  }

  get isMergeConflict(): boolean {
    const text = `${this.stderr} ${this.message}`.toLowerCase()
    return text.includes('conflict') || text.includes('automatic merge failed')
  }
}

export interface GitOptions {
  /** Extra environment, e.g. `GIT_INDEX_FILE`. */
  env?: Record<string, string>
  timeoutMs?: number
  /** Return a failing result instead of throwing. */
  allowFailure?: boolean
  signal?: AbortSignal
  /** Written to stdin, for commands like `hash-object --stdin`. */
  input?: string
}

export interface FileStatus {
  path: string
  /** Two-letter porcelain code, e.g. ` M`, `??`, `A `. */
  code: string
  staged: boolean
  worktreeModified: boolean
  untracked: boolean
}

export interface WorktreeInfo {
  path: string
  head: string
  branch: string | null
  locked: boolean
}

export class Git {
  constructor(
    /** Repository root, or any directory inside it. */
    readonly cwd: string
  ) {}

  /** Runs git and returns its output. Throws `GitError` unless allowed to fail. */
  async run(args: string[], options: GitOptions = {}): Promise<GitResult> {
    // `-c core.hooksPath=` keeps a repository's own hooks from running during
    // our bookkeeping: synchronizing metadata should never trigger someone's
    // pre-commit formatter or test suite.
    const argv = ['-c', 'core.hooksPath=', ...args]

    return new Promise<GitResult>((resolve, reject) => {
      const child = execFile(
        'git',
        argv,
        {
          cwd: this.cwd,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          env: {
            ...process.env,
            // Never let Git stop for a credential or passphrase prompt: it
            // would hang the app with no way for the user to answer.
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '',
            SSH_ASKPASS: '',
            ...options.env
          },
          ...(options.signal ? { signal: options.signal } : {})
        },
        (error, stdout, stderr) => {
          const exitCode =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : error
                ? 1
                : 0

          if (error && !options.allowFailure) {
            reject(
              new GitError(
                `git ${args.join(' ')} failed: ${stderr.trim() || error.message}`,
                args,
                exitCode,
                stderr
              )
            )
            return
          }
          resolve({ stdout, stderr, exitCode })
        }
      )

      if (options.input !== undefined) child.stdin?.end(options.input)
    })
  }

  /** Trimmed stdout, for the many commands that return one line. */
  private async line(args: string[], options: GitOptions = {}): Promise<string> {
    const { stdout } = await this.run(args, options)
    return stdout.trim()
  }

  // --- repository identity -------------------------------------------------

  static async isRepository(dir: string): Promise<boolean> {
    const git = new Git(dir)
    const { exitCode, stdout } = await git.run(
      ['rev-parse', '--is-inside-work-tree'],
      { allowFailure: true }
    )
    return exitCode === 0 && stdout.trim() === 'true'
  }

  async repositoryRoot(): Promise<string> {
    return this.line(['rev-parse', '--show-toplevel'])
  }

  /** The common `.git` directory, shared by every worktree. */
  async commonDir(): Promise<string> {
    const dir = await this.line(['rev-parse', '--git-common-dir'])
    return path.isAbsolute(dir) ? dir : path.resolve(this.cwd, dir)
  }

  async currentBranch(): Promise<string | null> {
    const branch = await this.line(['rev-parse', '--abbrev-ref', 'HEAD'])
    return branch === 'HEAD' ? null : branch
  }

  async headCommit(): Promise<string | null> {
    const { stdout, exitCode } = await this.run(['rev-parse', 'HEAD'], {
      allowFailure: true
    })
    return exitCode === 0 ? stdout.trim() : null
  }

  async configValue(key: string): Promise<string | null> {
    const { stdout, exitCode } = await this.run(['config', '--get', key], {
      allowFailure: true
    })
    return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : null
  }

  /** `Name <email>` from Git config, for attribution. Never authentication. */
  async identity(): Promise<{ name: string; email: string }> {
    const name = (await this.configValue('user.name')) ?? 'Unknown'
    const email = (await this.configValue('user.email')) ?? 'unknown@localhost'
    return { name, email }
  }

  async remoteUrl(remote = 'origin'): Promise<string | null> {
    return this.configValue(`remote.${remote}.url`)
  }

  async hasRemote(remote = 'origin'): Promise<boolean> {
    return (await this.remoteUrl(remote)) !== null
  }

  async addRemote(remote: string, url: string): Promise<void> {
    await this.run(['remote', 'add', remote, url])
  }

  // --- refs ----------------------------------------------------------------

  async resolveRef(ref: string): Promise<string | null> {
    const { stdout, exitCode } = await this.run(['rev-parse', '--verify', ref], {
      allowFailure: true
    })
    return exitCode === 0 ? stdout.trim() : null
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.resolveRef(`refs/heads/${branch}`)) !== null
  }

  async remoteBranchExists(branch: string, remote = 'origin'): Promise<boolean> {
    return (await this.resolveRef(`refs/remotes/${remote}/${branch}`)) !== null
  }

  /** Asks the remote directly, rather than trusting local tracking refs. */
  async remoteRefCommit(branch: string, remote = 'origin'): Promise<string | null> {
    const { stdout, exitCode } = await this.run(
      ['ls-remote', remote, `refs/heads/${branch}`],
      { allowFailure: true, timeoutMs: NETWORK_TIMEOUT_MS }
    )
    if (exitCode !== 0) return null
    const first = stdout.trim().split('\n')[0]
    return first ? (first.split(/\s+/)[0] ?? null) : null
  }

  async updateRef(ref: string, commit: string): Promise<void> {
    await this.run(['update-ref', ref, commit])
  }

  // --- status and diffs ----------------------------------------------------

  async status(): Promise<FileStatus[]> {
    const { stdout } = await this.run(['status', '--porcelain=v1', '-z'])
    const entries = stdout.split('\0').filter((entry) => entry !== '')
    const files: FileStatus[] = []
    for (const entry of entries) {
      const code = entry.slice(0, 2)
      const file = entry.slice(3)
      if (file === '') continue
      files.push({
        path: file,
        code,
        staged: code[0] !== ' ' && code[0] !== '?',
        worktreeModified: code[1] !== ' ' && code[1] !== '?',
        untracked: code === '??'
      })
    }
    return files
  }

  async isClean(): Promise<boolean> {
    return (await this.status()).length === 0
  }

  /** Files changed between two commits, project-relative POSIX. */
  async changedFiles(from: string, to: string): Promise<string[]> {
    const { stdout } = await this.run(['diff', '--name-only', '-z', `${from}..${to}`])
    return stdout.split('\0').filter((p) => p !== '')
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const { stdout, exitCode } = await this.run(['merge-base', a, b], {
      allowFailure: true
    })
    return exitCode === 0 ? stdout.trim() : null
  }

  async diff(from: string, to: string, paths: string[] = []): Promise<string> {
    const args = ['diff', `${from}..${to}`]
    if (paths.length > 0) args.push('--', ...paths)
    const { stdout } = await this.run(args)
    return stdout
  }

  /** Reads one file as it exists at a ref, without touching the working tree. */
  async readFileAtRef(ref: string, filePath: string): Promise<string | null> {
    const { stdout, exitCode } = await this.run(['show', `${ref}:${filePath}`], {
      allowFailure: true
    })
    return exitCode === 0 ? stdout : null
  }

  /** Lists the files present at a ref, optionally under one directory. */
  async listFilesAtRef(ref: string, dir?: string): Promise<string[]> {
    const args = ['ls-tree', '-r', '--name-only', '-z', ref]
    if (dir) args.push('--', dir)
    const { stdout, exitCode } = await this.run(args, { allowFailure: true })
    if (exitCode !== 0) return []
    return stdout.split('\0').filter((p) => p !== '')
  }

  // --- network -------------------------------------------------------------

  async fetch(
    remote = 'origin',
    refspecs: string[] = [],
    options: GitOptions = {}
  ): Promise<GitResult> {
    return this.run(['fetch', remote, ...refspecs], {
      timeoutMs: NETWORK_TIMEOUT_MS,
      ...options
    })
  }

  /**
   * Pushes, without force, ever.
   *
   * A rejected push is a normal outcome here, not an error to be bulldozed:
   * callers catch `GitError.isNonFastForward`, re-read, merge and retry.
   */
  async push(
    remote: string,
    refspec: string,
    options: GitOptions = {}
  ): Promise<GitResult> {
    if (/--force|\+/.test(refspec)) {
      throw new Error(
        `Refusing to force-push "${refspec}". Synchronization must never rewrite published history.`
      )
    }
    return this.run(['push', remote, refspec], {
      timeoutMs: NETWORK_TIMEOUT_MS,
      ...options
    })
  }

  static async clone(
    url: string,
    destination: string,
    options: GitOptions = {}
  ): Promise<Git> {
    const parent = path.dirname(destination)
    await fs.mkdir(parent, { recursive: true })
    const git = new Git(parent)
    await git.run(['clone', url, destination], {
      timeoutMs: NETWORK_TIMEOUT_MS,
      ...options
    })
    return new Git(destination)
  }

  // --- writing a branch without checking it out ----------------------------

  /**
   * Commits a set of files onto a branch without checking it out.
   *
   * This is how coordination metadata is written: the branch is built from
   * blobs and a temporary index, so the user's working tree and their
   * uncommitted changes are never involved. Checking out `collab-state` to
   * write a JSON file would be both slow and destructive.
   *
   * The returned commit is the new branch head. When `parent` is omitted the
   * branch is created as a root commit, which is what makes `collab-state` an
   * orphan branch carrying no project source.
   */
  async writeBranchFiles(options: {
    branch: string
    files: Record<string, string>
    message: string
    /** Commit to build on. Omit for a root commit. */
    parent?: string | null
    /** `true` to keep files already on `parent` that are not in `files`. */
    preserveExisting?: boolean
    author?: { name: string; email: string }
  }): Promise<string> {
    const indexFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-idx-')),
      'index'
    )
    const env = { GIT_INDEX_FILE: indexFile }

    try {
      if (options.parent && options.preserveExisting !== false) {
        // Start from the parent's tree so untouched files survive.
        await this.run(['read-tree', options.parent], { env })
      }

      for (const [filePath, content] of Object.entries(options.files)) {
        const { stdout } = await this.run(
          ['hash-object', '-w', '--stdin', '--path', filePath],
          { env, input: content }
        )
        const blob = stdout.trim()
        await this.run(
          ['update-index', '--add', '--cacheinfo', `100644,${blob},${filePath}`],
          { env }
        )
      }

      const tree = (await this.run(['write-tree'], { env })).stdout.trim()

      const commitArgs = ['commit-tree', tree]
      if (options.parent) commitArgs.push('-p', options.parent)
      commitArgs.push('-m', options.message)

      const identity = options.author ?? (await this.identity())
      const commit = (
        await this.run(commitArgs, {
          env: {
            ...env,
            GIT_AUTHOR_NAME: identity.name,
            GIT_AUTHOR_EMAIL: identity.email,
            GIT_COMMITTER_NAME: identity.name,
            GIT_COMMITTER_EMAIL: identity.email
          }
        })
      ).stdout.trim()

      await this.updateRef(`refs/heads/${options.branch}`, commit)
      return commit
    } finally {
      await fs.rm(path.dirname(indexFile), { recursive: true, force: true })
    }
  }

  // --- worktrees -----------------------------------------------------------

  async worktrees(): Promise<WorktreeInfo[]> {
    const { stdout } = await this.run(['worktree', 'list', '--porcelain'])
    const infos: WorktreeInfo[] = []
    let current: Partial<WorktreeInfo> = {}

    for (const raw of stdout.split('\n')) {
      const line = raw.trim()
      if (line === '') {
        if (current.path) {
          infos.push({
            path: current.path,
            head: current.head ?? '',
            branch: current.branch ?? null,
            locked: current.locked ?? false
          })
        }
        current = {}
        continue
      }
      if (line.startsWith('worktree ')) current.path = line.slice(9)
      else if (line.startsWith('HEAD ')) current.head = line.slice(5)
      else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace(/^refs\/heads\//, '')
      } else if (line === 'locked') current.locked = true
    }
    if (current.path) {
      infos.push({
        path: current.path,
        head: current.head ?? '',
        branch: current.branch ?? null,
        locked: current.locked ?? false
      })
    }
    return infos
  }

  /** Creates a worktree on a new branch forked from `baseCommit`. */
  async addWorktree(options: {
    worktreePath: string
    branch: string
    baseCommit: string
  }): Promise<void> {
    await fs.mkdir(path.dirname(options.worktreePath), { recursive: true })
    const exists = await this.branchExists(options.branch)
    await this.run([
      'worktree',
      'add',
      ...(exists ? [] : ['-b', options.branch]),
      options.worktreePath,
      ...(exists ? [options.branch] : [options.baseCommit])
    ])
  }

  async removeWorktree(worktreePath: string, force = false): Promise<void> {
    await this.run(
      ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath],
      { allowFailure: true }
    )
    await this.run(['worktree', 'prune'], { allowFailure: true })
  }

  // --- commits and merges --------------------------------------------------

  /** Stages everything in this worktree and commits. Returns `null` if clean. */
  async commitAll(
    message: string,
    author?: { name: string; email: string }
  ): Promise<string | null> {
    await this.run(['add', '-A'])
    const staged = await this.run(['diff', '--cached', '--quiet'], {
      allowFailure: true
    })
    if (staged.exitCode === 0) return null

    const identity = author ?? (await this.identity())
    await this.run(['commit', '-m', message], {
      env: {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email
      }
    })
    return this.headCommit()
  }

  /**
   * Tests whether two commits merge cleanly, touching nothing.
   *
   * Uses `merge-tree`, which computes the merge in the object database and
   * writes neither the index nor the working tree. That is essential: a trial
   * merge must never leave a user's checkout in a conflicted state.
   */
  async canMergeCleanly(
    base: string,
    ours: string,
    theirs: string
  ): Promise<{ clean: boolean; conflictingPaths: string[] }> {
    // Modern `merge-tree --write-tree` reports conflicts machine-readably.
    const modern = await this.run(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs],
      { allowFailure: true }
    )
    if (modern.exitCode === 0) return { clean: true, conflictingPaths: [] }
    if (modern.exitCode === 1) {
      // Output is the tree oid, then one conflicting path per line.
      const lines = modern.stdout.trim().split('\n').slice(1)
      return {
        clean: false,
        conflictingPaths: lines.map((l) => l.trim()).filter((l) => l !== '')
      }
    }

    // Older Git: fall back to the three-way form, which prints `<<<<<<<` for
    // conflicted hunks and tells us nothing precise about paths.
    const legacy = await this.run(['merge-tree', base, ours, theirs], {
      allowFailure: true
    })
    const conflicted = legacy.stdout.includes('<<<<<<<')
    return { clean: !conflicted, conflictingPaths: [] }
  }

  /** Merges a branch into the current one, committing the result. */
  async merge(
    branch: string,
    message: string
  ): Promise<{ ok: boolean; conflictingPaths: string[]; commit: string | null }> {
    const result = await this.run(
      ['merge', '--no-ff', '-m', message, branch],
      { allowFailure: true }
    )
    if (result.exitCode === 0) {
      return { ok: true, conflictingPaths: [], commit: await this.headCommit() }
    }

    const conflicted = await this.run(['diff', '--name-only', '--diff-filter=U', '-z'], {
      allowFailure: true
    })
    // Leave no half-merged state behind: the caller decides what to do next.
    await this.run(['merge', '--abort'], { allowFailure: true })
    return {
      ok: false,
      conflictingPaths: conflicted.stdout.split('\0').filter((p) => p !== ''),
      commit: null
    }
  }
}
