/**
 * Two-clone collaboration tests.
 *
 * These use **real Git**: a local bare repository as the shared remote, and two
 * real clones with their own working trees, exactly as two developers on two
 * machines would have. Nothing about collaboration is simulated — if these
 * pass, two clones really can coordinate through a Git remote.
 *
 * The scenarios map onto the acceptance criteria:
 *
 *   - both clones converge on the same state after synchronizing
 *   - concurrent edits to *different* entities both survive
 *   - a concurrent edit to the *same* entity picks a deterministic winner and
 *     says so, rather than silently dropping one
 *   - append-only history (activity, instructions, events) is never lost
 *   - reservations are advisory, expire, and are not stolen while live
 *   - a failed push leaves the work queued rather than discarded
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Git } from '../../src/core/git/git'
import {
  COLLAB_BRANCH,
  GitCollaborationProvider,
  initializeCollaboration,
  inspectWorkspace,
  joinCollaboration
} from '../../src/core/collab'
import { silentLogger } from '../../src/core/logger'
import { isReservationExpired } from '../../src/shared/collab'

const log = silentLogger.child('collab')
const scratch: string[] = []

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cartograph-${label}-`))
  scratch.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of scratch.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** Git needs an identity to commit; CI machines often have none. */
async function configure(git: Git, name: string, email: string): Promise<void> {
  await git.run(['config', 'user.name', name])
  await git.run(['config', 'user.email', email])
  await git.run(['config', 'commit.gpgsign', 'false'])
}

interface World {
  remote: string
  alice: { root: string; git: Git; provider: GitCollaborationProvider }
  bob: { root: string; git: Git; provider: GitCollaborationProvider }
}

/**
 * Builds a bare remote plus two clones with a small project in them, and
 * initializes collaboration from Alice's clone.
 */
async function createWorld(): Promise<World> {
  const base = await tempDir('world')
  const remote = path.join(base, 'remote.git')
  const seed = path.join(base, 'seed')

  // The shared remote.
  await fs.mkdir(remote, { recursive: true })
  await new Git(base).run(['init', '--bare', '--initial-branch=main', remote])

  // A seed repository with some source, pushed to the remote.
  await fs.mkdir(path.join(seed, 'src', 'auth'), { recursive: true })
  await fs.mkdir(path.join(seed, 'src', 'notifications'), { recursive: true })
  await fs.writeFile(
    path.join(seed, 'src', 'auth', 'index.ts'),
    'export function validateToken(token: string): boolean {\n  return token.length > 0\n}\n'
  )
  await fs.writeFile(
    path.join(seed, 'src', 'notifications', 'index.ts'),
    'export function notify(message: string): void {\n  console.log(message)\n}\n'
  )
  await fs.writeFile(
    path.join(seed, 'package.json'),
    `${JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2)}\n`
  )

  const seedGit = new Git(seed)
  await seedGit.run(['init', '--initial-branch=main'])
  await configure(seedGit, 'Seed', 'seed@example.com')
  await seedGit.run(['add', '-A'])
  await seedGit.run(['commit', '-m', 'initial'])
  await seedGit.addRemote('origin', remote)
  await seedGit.push('origin', 'refs/heads/main:refs/heads/main')

  // Two clones, as two developers would have.
  const aliceRoot = path.join(base, 'alice')
  const bobRoot = path.join(base, 'bob')
  await Git.clone(remote, aliceRoot)
  await Git.clone(remote, bobRoot)

  const aliceGit = new Git(aliceRoot)
  const bobGit = new Git(bobRoot)
  await configure(aliceGit, 'Alice', 'alice@example.com')
  await configure(bobGit, 'Bob', 'bob@example.com')

  // Alice sets the project up; Bob joins it.
  await initializeCollaboration({
    root: aliceRoot,
    developerId: 'alice',
    projectName: 'demo',
    logger: log
  })
  await joinCollaboration({ root: bobRoot, logger: log })

  const alice = new GitCollaborationProvider({
    repoRoot: aliceRoot,
    developerId: 'alice',
    displayName: 'Alice',
    logger: log
  })
  const bob = new GitCollaborationProvider({
    repoRoot: bobRoot,
    developerId: 'bob',
    displayName: 'Bob',
    logger: log
  })
  await alice.connect()
  await bob.connect()

  return {
    remote,
    alice: { root: aliceRoot, git: aliceGit, provider: alice },
    bob: { root: bobRoot, git: bobGit, provider: bob }
  }
}

let world: World

beforeEach(async () => {
  world = await createWorld()
})

describe('initializing and joining a collaborative project', () => {
  it('creates an orphan coordination branch holding no source code', async () => {
    const files = await world.alice.git.listFilesAtRef(`refs/heads/${COLLAB_BRANCH}`)
    expect(files.length).toBeGreaterThan(0)
    // The whole point of the orphan branch: metadata only.
    expect(files.every((f) => f.startsWith('collab/'))).toBe(true)
    expect(files).not.toContain('package.json')
    expect(files.some((f) => f.startsWith('src/'))).toBe(false)
  })

  it('never touches the working tree', async () => {
    // Initializing and synchronizing must leave the checkout exactly as it was.
    expect(await world.alice.git.isClean()).toBe(true)
    expect(await world.alice.git.currentBranch()).toBe('main')
    await world.alice.provider.synchronize()
    expect(await world.alice.git.isClean()).toBe(true)
    expect(await world.alice.git.currentBranch()).toBe('main')
  })

  it('reports the workspace it can see', async () => {
    const info = await inspectWorkspace(world.bob.root)
    expect(info.isGitRepository).toBe(true)
    expect(info.collaborationInitialized).toBe(true)
    expect(info.remoteUrl).toContain('remote.git')
    expect(info.currentBranch).toBe('main')
    expect(info.identity.name).toBe('Bob')
  })

  it('refuses to re-initialize a project that already has collaboration', async () => {
    await expect(
      initializeCollaboration({
        root: world.alice.root,
        developerId: 'alice',
        projectName: 'demo',
        logger: log
      })
    ).rejects.toThrow(/already has/)
  })

  it('tells a developer to initialize when the remote has no coordination branch', async () => {
    const base = await tempDir('bare');
    const remote = path.join(base, 'empty.git')
    await new Git(base).run(['init', '--bare', '--initial-branch=main', remote])
    const clone = path.join(base, 'clone')
    await fs.mkdir(clone, { recursive: true })
    const git = new Git(clone)
    await git.run(['init', '--initial-branch=main'])
    await configure(git, 'Carol', 'carol@example.com')
    await git.addRemote('origin', remote)

    await expect(joinCollaboration({ root: clone, logger: log })).rejects.toThrow(
      /not set up for collaboration/
    )
  })
})

describe('synchronizing between two clones', () => {
  it("shows Alice's task to Bob after they both sync", async () => {
    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-oauth',
        title: 'Implement OAuth login',
        description: 'Add OAuth authentication support',
        moduleIds: ['authentication'],
        assignedAgent: 'agent-a',
        graphVersion: 15
      }
    })

    const published = await world.alice.provider.synchronize()
    expect(published.online).toBe(true)
    expect(published.error).toBeNull()
    expect(published.queued).toBe(0)

    // Bob knows nothing until he synchronizes — and the API never pretends
    // otherwise.
    expect(world.bob.provider.getTasks()).toHaveLength(0)

    const received = await world.bob.provider.synchronize()
    expect(received.online).toBe(true)
    const task = world.bob.provider.getTasks()[0]
    expect(task.title).toBe('Implement OAuth login')
    expect(task.assignedAgent).toBe('agent-a')
    expect(task.moduleIds).toEqual(['authentication'])
  })

  it('reports staleness until the first successful sync', async () => {
    expect(world.bob.provider.getFreshness().stale).toBe(true)
    await world.bob.provider.synchronize()
    const fresh = world.bob.provider.getFreshness()
    expect(fresh.stale).toBe(false)
    expect(fresh.lastSyncAt).not.toBeNull()
    expect(fresh.online).toBe(true)
  })

  it('converges on the same state from either direction', async () => {
    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-a',
        title: 'A',
        description: '',
        moduleIds: ['authentication'],
        graphVersion: 1
      }
    })
    await world.bob.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-b',
        title: 'B',
        description: '',
        moduleIds: ['notifications'],
        graphVersion: 1
      }
    })

    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()
    await world.alice.provider.synchronize()

    const aliceIds = world.alice.provider.getTasks().map((t) => t.id).sort()
    const bobIds = world.bob.provider.getTasks().map((t) => t.id).sort()
    expect(aliceIds).toEqual(['task-a', 'task-b'])
    expect(bobIds).toEqual(['task-a', 'task-b'])
  })
})

describe('concurrent metadata edits', () => {
  it('keeps both tasks when Alice and Bob create different ones at once', async () => {
    // Neither has seen the other's work: both are writing from the same base.
    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-alice',
        title: 'Alice task',
        description: '',
        moduleIds: ['authentication'],
        graphVersion: 1
      }
    })
    await world.bob.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-bob',
        title: 'Bob task',
        description: '',
        moduleIds: ['notifications'],
        graphVersion: 1
      }
    })

    // Alice wins the race to the remote; Bob's push is rejected, re-merged and
    // retried. Both must survive — this is the acceptance criterion.
    const first = await world.alice.provider.synchronize()
    const second = await world.bob.provider.synchronize()

    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect(second.retries).toBeGreaterThanOrEqual(1)

    await world.alice.provider.synchronize()

    for (const provider of [world.alice.provider, world.bob.provider]) {
      const ids = provider.getTasks().map((t) => t.id).sort()
      expect(ids).toEqual(['task-alice', 'task-bob'])
    }
  })

  it('keeps independent edits to two different existing tasks', async () => {
    for (const id of ['task-1', 'task-2']) {
      await world.alice.provider.submitOperation({
        kind: 'create_task',
        task: { id, title: id, description: '', moduleIds: [id], graphVersion: 1 }
      })
    }
    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()

    // Alice edits one, Bob edits the other, neither having seen the other.
    await world.alice.provider.submitOperation({
      kind: 'update_task',
      taskId: 'task-1',
      changes: { status: 'coding', title: 'task-1 (Alice)' }
    })
    await world.bob.provider.submitOperation({
      kind: 'update_task',
      taskId: 'task-2',
      changes: { status: 'testing', title: 'task-2 (Bob)' }
    })

    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()
    await world.alice.provider.synchronize()

    for (const provider of [world.alice.provider, world.bob.provider]) {
      const byId = new Map(provider.getTasks().map((t) => [t.id, t]))
      expect(byId.get('task-1')?.status).toBe('coding')
      expect(byId.get('task-1')?.title).toBe('task-1 (Alice)')
      expect(byId.get('task-2')?.status).toBe('testing')
      expect(byId.get('task-2')?.title).toBe('task-2 (Bob)')
    }
  })

  it('picks a deterministic winner for the same task and reports the contest', async () => {
    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'shared',
        title: 'shared',
        description: '',
        moduleIds: ['authentication'],
        graphVersion: 1
      }
    })
    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()

    await world.alice.provider.submitOperation({
      kind: 'update_task',
      taskId: 'shared',
      changes: { title: 'Alice wording' }
    })
    await world.bob.provider.submitOperation({
      kind: 'update_task',
      taskId: 'shared',
      changes: { title: 'Bob wording' }
    })

    await world.alice.provider.synchronize()
    const bobReport = await world.bob.provider.synchronize()
    await world.alice.provider.synchronize()

    // One wording wins, both clones agree which, and the loser was told.
    const aliceTitle = world.alice.provider.getTasks()[0].title
    const bobTitle = world.bob.provider.getTasks()[0].title
    expect(aliceTitle).toBe(bobTitle)
    expect(['Alice wording', 'Bob wording']).toContain(aliceTitle)
    expect(bobReport.contested.some((c) => c.kind === 'task' && c.id === 'shared')).toBe(
      true
    )
  })

  it('never loses an event from either side of the shared timeline', async () => {
    await world.alice.provider.submitOperation({
      kind: 'record_event',
      event: { kind: 'agent_started', message: 'Alice started agent A' }
    })
    await world.bob.provider.submitOperation({
      kind: 'record_event',
      event: { kind: 'agent_started', message: 'Bob started agent B' }
    })

    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()
    await world.alice.provider.synchronize()

    for (const provider of [world.alice.provider, world.bob.provider]) {
      const messages = provider.getProjectState().events.map((e) => e.message)
      expect(messages).toContain('Alice started agent A')
      expect(messages).toContain('Bob started agent B')
    }
  })
})

describe('module reservations', () => {
  async function aliceClaims(moduleId: string, leaseSeconds?: number): Promise<void> {
    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: `task-${moduleId}`,
        title: `work on ${moduleId}`,
        description: '',
        moduleIds: [moduleId],
        graphVersion: 1
      }
    })
    await world.alice.provider.submitOperation({
      kind: 'claim_module',
      moduleId,
      taskId: `task-${moduleId}`,
      ...(leaseSeconds === undefined ? {} : { leaseSeconds })
    })
  }

  it('shows Bob that Alice holds a module', async () => {
    await aliceClaims('authentication')
    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()

    const reservation = world.bob.provider
      .getReservations()
      .find((r) => r.moduleId === 'authentication')
    expect(reservation?.owner).toBe('alice')
    expect(isReservationExpired(reservation!)).toBe(false)
  })

  it('does not let Bob quietly take a live reservation', async () => {
    await aliceClaims('authentication')
    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()

    await world.bob.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-bob',
        title: 'bob also wants auth',
        description: '',
        moduleIds: ['authentication'],
        graphVersion: 1
      }
    })
    await world.bob.provider.submitOperation({
      kind: 'claim_module',
      moduleId: 'authentication',
      taskId: 'task-bob'
    })
    await world.bob.provider.synchronize()

    // Advisory, but not a free-for-all: the live holder keeps it.
    expect(
      world.bob.provider.getReservations().find((r) => r.moduleId === 'authentication')
        ?.owner
    ).toBe('alice')
  })

  it('treats an expired lease as available and reports the expiry', async () => {
    await aliceClaims('authentication', -1)
    const report = await world.alice.provider.synchronize()

    expect(report.expiredReservations).toContain('authentication')
    const reservation = world.alice.provider
      .getReservations()
      .find((r) => r.moduleId === 'authentication')
    expect(isReservationExpired(reservation!)).toBe(true)

    // And a second developer may then claim it.
    await world.bob.provider.synchronize()
    await world.bob.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-bob',
        title: 'take over',
        description: '',
        moduleIds: ['authentication'],
        graphVersion: 1
      }
    })
    await world.bob.provider.submitOperation({
      kind: 'claim_module',
      moduleId: 'authentication',
      taskId: 'task-bob'
    })
    await world.bob.provider.synchronize()
    expect(
      world.bob.provider.getReservations().find((r) => r.moduleId === 'authentication')
        ?.owner
    ).toBe('bob')
  })

  it('releases a module when its holder lets go', async () => {
    await aliceClaims('authentication')
    await world.alice.provider.synchronize()

    await world.alice.provider.submitOperation({
      kind: 'release_module',
      moduleId: 'authentication'
    })
    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()

    const reservation = world.bob.provider
      .getReservations()
      .find((r) => r.moduleId === 'authentication')
    expect(isReservationExpired(reservation!)).toBe(true)
  })
})

describe('shared agent sessions', () => {
  it('lets Bob queue an instruction that reaches Alice', async () => {
    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-oauth',
        title: 'OAuth',
        description: '',
        moduleIds: ['authentication'],
        graphVersion: 1
      }
    })
    await world.alice.provider.submitOperation({
      kind: 'upsert_session',
      session: {
        id: 'session-1',
        taskId: 'task-oauth',
        status: 'running',
        branch: 'agent/task-oauth',
        host: {
          hostId: 'alice-host',
          developerId: 'alice',
          lastHeartbeatAt: new Date().toISOString()
        }
      }
    })
    await world.alice.provider.submitOperation({
      kind: 'append_activity',
      sessionId: 'session-1',
      entries: [
        { id: 'a1', at: new Date().toISOString(), kind: 'plan', message: 'Read auth module' }
      ]
    })
    await world.alice.provider.synchronize()

    // Bob sees the session he did not start, and adds to it.
    await world.bob.provider.synchronize()
    const seen = world.bob.provider.getAgentSessions()[0]
    expect(seen.taskId).toBe('task-oauth')
    expect(seen.activity.map((a) => a.message)).toContain('Read auth module')

    await world.bob.provider.submitOperation({
      kind: 'queue_instruction',
      sessionId: 'session-1',
      text: 'Please also handle token refresh'
    })
    await world.bob.provider.synchronize()

    // Alice's host picks it up.
    await world.alice.provider.synchronize()
    const pending = world.alice.provider
      .getAgentSessions()[0]
      .instructions.filter((i) => i.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0].text).toBe('Please also handle token refresh')
    expect(pending[0].fromDeveloper).toBe('bob')
  })

  it('keeps both the host’s progress and a watcher’s instruction', async () => {
    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-1',
        title: 'T',
        description: '',
        moduleIds: ['authentication'],
        graphVersion: 1
      }
    })
    await world.alice.provider.submitOperation({
      kind: 'upsert_session',
      session: { id: 's1', taskId: 'task-1', status: 'running' }
    })
    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()

    // Simultaneous: Alice's agent reports progress, Bob sends an instruction.
    await world.alice.provider.submitOperation({
      kind: 'append_activity',
      sessionId: 's1',
      entries: [
        { id: 'p1', at: new Date().toISOString(), kind: 'progress', message: 'wrote login.ts' }
      ]
    })
    await world.bob.provider.submitOperation({
      kind: 'queue_instruction',
      sessionId: 's1',
      text: 'add tests'
    })

    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()
    await world.alice.provider.synchronize()

    // Neither append may clobber the other: this is the case a last-write-wins
    // merge would silently break.
    for (const provider of [world.alice.provider, world.bob.provider]) {
      const session = provider.getAgentSessions()[0]
      expect(session.activity.map((a) => a.id)).toContain('p1')
      expect(session.instructions.map((i) => i.text)).toContain('add tests')
    }
  })

  it('records an instruction as applied once the host processes it', async () => {
    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'task-1',
        title: 'T',
        description: '',
        moduleIds: ['a'],
        graphVersion: 1
      }
    })
    await world.alice.provider.submitOperation({
      kind: 'upsert_session',
      session: { id: 's1', taskId: 'task-1', status: 'running' }
    })
    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()

    await world.bob.provider.submitOperation({
      kind: 'queue_instruction',
      sessionId: 's1',
      text: 'do the thing'
    })
    await world.bob.provider.synchronize()
    await world.alice.provider.synchronize()

    const instruction = world.alice.provider.getAgentSessions()[0].instructions[0]
    await world.alice.provider.submitOperation({
      kind: 'resolve_instruction',
      sessionId: 's1',
      instructionId: instruction.id,
      status: 'applied',
      note: 'folded into turn 3'
    })
    await world.alice.provider.synchronize()
    await world.bob.provider.synchronize()

    // The host owns the status, so Bob sees it advance even though he wrote
    // the entry.
    const seen = world.bob.provider.getAgentSessions()[0].instructions[0]
    expect(seen.status).toBe('applied')
    expect(seen.note).toBe('folded into turn 3')
  })
})

describe('working offline', () => {
  it('keeps serving cached state and queues the work', async () => {
    await world.alice.provider.synchronize()

    // Break the remote: the URL still exists, the repository does not.
    await world.alice.git.run(['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'cartograph-missing.git')])

    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'offline-task',
        title: 'Written while offline',
        description: '',
        moduleIds: ['authentication'],
        graphVersion: 1
      }
    })

    const report = await world.alice.provider.synchronize()
    expect(report.online).toBe(false)
    expect(report.error).not.toBeNull()
    // The work is not lost, and is not claimed to have been shared.
    expect(report.queued).toBe(1)
    expect(report.published).toBe(0)
    expect(world.alice.provider.getTasks()[0].title).toBe('Written while offline')
    expect(world.alice.provider.getFreshness().queued).toBe(1)

    // Reconnecting publishes it.
    await world.alice.git.run(['remote', 'set-url', 'origin', world.remote])
    const recovered = await world.alice.provider.synchronize()
    expect(recovered.online).toBe(true)
    expect(recovered.error).toBeNull()
    expect(recovered.queued).toBe(0)

    await world.bob.provider.synchronize()
    expect(world.bob.provider.getTasks().map((t) => t.id)).toContain('offline-task')
  })

  it('replays a queue that outlived a restart', async () => {
    await world.alice.git.run(['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'cartograph-missing.git')])
    await world.alice.provider.submitOperation({
      kind: 'create_task',
      task: {
        id: 'survives-restart',
        title: 'Queued before the crash',
        description: '',
        moduleIds: ['authentication'],
        graphVersion: 1
      }
    })
    await world.alice.provider.synchronize()
    await world.alice.provider.disconnect()

    // A brand-new provider over the same repository, as after a restart.
    const restarted = new GitCollaborationProvider({
      repoRoot: world.alice.root,
      developerId: 'alice',
      displayName: 'Alice',
      logger: log
    })
    await restarted.connect()
    expect(restarted.getTasks().map((t) => t.id)).toContain('survives-restart')

    await world.alice.git.run(['remote', 'set-url', 'origin', world.remote])
    const report = await restarted.synchronize()
    expect(report.error).toBeNull()
    await world.bob.provider.synchronize()
    expect(world.bob.provider.getTasks().map((t) => t.id)).toContain('survives-restart')
  })
})
