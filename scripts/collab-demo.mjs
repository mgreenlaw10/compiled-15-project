/**
 * Sets up a two-developer collaboration demo on one machine.
 *
 * Creates a local bare repository as the shared remote and two clones of a
 * small sample project, then prints the two commands that launch Cartograph as
 * Alice and as Bob.
 *
 * Everything is real: real Git, a real remote, two real clones, two instances
 * with separate identities. Nothing about the collaboration is simulated.
 *
 *   node scripts/collab-demo.mjs            # create under ./.collab-demo
 *   node scripts/collab-demo.mjs --reset    # delete and recreate
 *   node scripts/collab-demo.mjs --dir /tmp/demo
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const reset = args.includes('--reset')
const dirFlag = args.indexOf('--dir')
const demoDir = path.resolve(
  dirFlag !== -1 && args[dirFlag + 1] ? args[dirFlag + 1] : path.join(root, '.collab-demo')
)

async function git(cwd, ...argv) {
  // No shell, and hooks disabled: this is setup, not someone's workflow.
  return run('git', ['-c', 'core.hooksPath=', ...argv], { cwd, windowsHide: true })
}

/**
 * A project with two clearly separate modules and one cross-module call.
 *
 * The call matters: it is what makes the conflict-detection demo possible.
 * `payments` calls `validateToken`, so if an agent changes that signature the
 * integration step has a real dependency to find.
 */
const FILES = {
  'package.json': `${JSON.stringify(
    {
      name: 'collab-demo',
      version: '1.0.0',
      private: true,
      scripts: { typecheck: 'tsc --noEmit' }
    },
    null,
    2
  )}\n`,
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true
      },
      include: ['src']
    },
    null,
    2
  )}\n`,
  'src/auth/index.ts':
    '/** Authentication: who the caller is. */\n' +
    '\n' +
    'export interface Session {\n' +
    '  userId: string\n' +
    '  expiresAt: number\n' +
    '}\n' +
    '\n' +
    '/** Returns true when the token is well-formed and unexpired. */\n' +
    'export function validateToken(token: string): boolean {\n' +
    '  return token.length > 0 && !token.startsWith("expired:")\n' +
    '}\n' +
    '\n' +
    'export function createSession(userId: string): Session {\n' +
    '  return { userId, expiresAt: Date.now() + 3_600_000 }\n' +
    '}\n',
  'src/payments/index.ts':
    '/** Payments: taking money. Depends on Authentication. */\n' +
    '\n' +
    'import { validateToken } from "../auth/index"\n' +
    '\n' +
    'export interface Charge {\n' +
    '  amount: number\n' +
    '  currency: string\n' +
    '}\n' +
    '\n' +
    'export function charge(token: string, amount: number): Charge | null {\n' +
    '  // The cross-module call that conflict detection reasons about.\n' +
    '  if (!validateToken(token)) return null\n' +
    '  return { amount, currency: "USD" }\n' +
    '}\n',
  'src/notifications/index.ts':
    '/** Notifications: telling people things. Independent of the others. */\n' +
    '\n' +
    'export type Channel = "email" | "sms"\n' +
    '\n' +
    'export function notify(channel: Channel, message: string): void {\n' +
    '  console.log(`[${channel}] ${message}`)\n' +
    '}\n',
  'src/index.ts':
    'export * from "./auth/index"\n' +
    'export * from "./payments/index"\n' +
    'export * from "./notifications/index"\n',
  'README.md':
    '# Collaboration demo project\n' +
    '\n' +
    'Three modules. `payments` calls `auth.validateToken`, which is what makes\n' +
    'cross-module conflict detection demonstrable; `notifications` is independent,\n' +
    'so two agents can work in parallel without colliding.\n'
}

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (reset && (await exists(demoDir))) {
    console.log(`Removing ${demoDir}`)
    await fs.rm(demoDir, { recursive: true, force: true })
  }

  if (await exists(demoDir)) {
    console.log(`${demoDir} already exists. Re-run with --reset to recreate it.\n`)
    printInstructions()
    return
  }

  const remote = path.join(demoDir, 'remote.git')
  const seed = path.join(demoDir, 'seed')
  const alice = path.join(demoDir, 'alice')
  const bob = path.join(demoDir, 'bob')

  console.log(`Creating the demo in ${demoDir}`)
  await fs.mkdir(demoDir, { recursive: true })

  // The shared "server": a bare repository both clones push to and fetch from.
  await git(demoDir, 'init', '--bare', '--initial-branch=main', remote)

  // Seed it with the project.
  await fs.mkdir(seed, { recursive: true })
  for (const [relative, content] of Object.entries(FILES)) {
    const target = path.join(seed, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  await git(seed, 'init', '--initial-branch=main')
  await git(seed, 'config', 'user.name', 'Demo Seed')
  await git(seed, 'config', 'user.email', 'seed@example.com')
  await git(seed, 'config', 'commit.gpgsign', 'false')
  await git(seed, 'add', '-A')
  await git(seed, 'commit', '-m', 'Initial project: auth, payments, notifications')
  await git(seed, 'remote', 'add', 'origin', remote)
  await git(seed, 'push', 'origin', 'refs/heads/main:refs/heads/main')

  // Two developers, two clones — exactly as two machines would have.
  for (const [dir, name, email] of [
    [alice, 'Alice', 'alice@example.com'],
    [bob, 'Bob', 'bob@example.com']
  ]) {
    await git(demoDir, 'clone', remote, dir)
    await git(dir, 'config', 'user.name', name)
    await git(dir, 'config', 'user.email', email)
    await git(dir, 'config', 'commit.gpgsign', 'false')
  }

  console.log('\nDone.\n')
  printInstructions()
}

function printInstructions() {
  const rel = (target) => path.relative(root, target) || '.'
  const alice = rel(path.join(demoDir, 'alice'))
  const bob = rel(path.join(demoDir, 'bob'))

  console.log(`Shared remote : ${rel(path.join(demoDir, 'remote.git'))}
Alice's clone : ${alice}
Bob's clone   : ${bob}

Build once, then start two instances. Each needs its own CARTOGRAPH_PROFILE:
that gives it a separate userData directory, which is what makes it a separate
single-instance lock, a separate collaboration identity and separate settings.
Without it the second instance would quit, and both would be the same person.

  npm run build

  # terminal 1
  npm run demo:alice

  # terminal 2
  npm run demo:bob

Each window's title bar says which profile it is.

Then, in the app:

  1. Alice: Open Project -> ${alice}
  2. Alice: Team -> Set up collaboration... -> Initialize collaboration
  3. Bob:   Open Project -> ${bob}
  4. Bob:   Team -> Set up collaboration... -> Join this project
  5. Alice: select the auth module -> New task -> "Add OAuth login" -> start agent
  6. Bob:   Sync now. Alice's task appears; auth shows Coding with her agent.
  7. Bob:   select notifications -> New task -> start a second agent.
             Two agents now edit two worktrees on two branches.
  8. Either: Agents tab -> open the other's session -> queue an instruction.
  9. Either: when an agent finishes, Review and integrate...

To show conflict detection: give Alice's agent a task that changes
validateToken's return type. payments calls it, so integration reports the
incompatibility and names the affected module instead of merging quietly.

An API key is needed for agents to run (Settings). Everything else -- the graph,
tasks, reservations, sync, integration assessment -- works without one. Note
that each profile has its own settings, so the key must be entered in both.
`)
}

main().catch((error) => {
  console.error(`\nThe demo setup failed: ${error.message}`)
  process.exitCode = 1
})
