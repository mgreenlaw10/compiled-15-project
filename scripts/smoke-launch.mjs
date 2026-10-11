/**
 * Launches the built application and reports whether it survived startup.
 *
 * The automated tests cover the pipeline and the React tree, but neither one
 * actually boots Electron. This does: it starts the real app, watches the
 * console for the first few seconds, and fails if the process dies or the
 * renderer logs an error. Run it after `npm run build`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import electron from 'electron'

const WAIT_MS = Number(process.env.SMOKE_WAIT_MS ?? 9000)

if (!existsSync('out/main/index.js')) {
  console.error('out/main/index.js is missing — run `npm run build` first.')
  process.exit(1)
}

const startedAt = Date.now()
const child = spawn(electron, ['.'], {
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
})

let output = ''
let exitCode = null
let exitedAfterMs = null
child.stdout.on('data', (chunk) => {
  output += chunk.toString()
})
child.stderr.on('data', (chunk) => {
  output += chunk.toString()
})
child.on('exit', (code) => {
  exitCode = code
  exitedAfterMs = Date.now() - startedAt
})

await new Promise((resolve) => setTimeout(resolve, WAIT_MS))

/**
 * Electron spawns GPU and renderer helpers, and SIGTERM to the parent does not
 * reliably take them with it on Windows. Leaving one alive would make the
 * *next* run fail, because the app holds a single-instance lock.
 */
function stop() {
  if (exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore'
    })
  } else {
    child.kill('SIGTERM')
  }
}
stop()

const trimmed = output.trim()
if (trimmed !== '') {
  console.log('--- console output ---')
  console.log(trimmed)
}

// Electron logs plenty of harmless notices; only renderer errors matter.
const errors = trimmed
  .split('\n')
  .filter((line) => /CONSOLE.*(Error|Uncaught|Warning: )/.test(line))

if (exitCode !== null) {
  // A clean, immediate exit is what the single-instance lock looks like: the
  // second copy focuses the first and quits. That is correct behaviour, but it
  // means this run verified nothing.
  if (exitCode === 0 && exitedAfterMs !== null && exitedAfterMs < 4000) {
    console.error(
      `INCONCLUSIVE: the app exited cleanly after ${exitedAfterMs} ms, which is what happens when another copy of Cartograph is already running (it holds a single-instance lock). Close it and run this again.`
    )
  } else {
    console.error(
      `FAILED: the app exited with code ${exitCode} after ${exitedAfterMs} ms, before the ${WAIT_MS} ms window was up.`
    )
  }
  process.exit(1)
}
if (errors.length > 0) {
  console.error(`FAILED: the renderer logged ${errors.length} error(s).`)
  process.exit(1)
}

console.log(
  `OK: the app started and stayed up for ${WAIT_MS} ms with no renderer errors.`
)
