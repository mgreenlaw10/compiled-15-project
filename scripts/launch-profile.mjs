/**
 * Launches Cartograph under a named instance profile.
 *
 * Exists because `CARTOGRAPH_PROFILE=alice electron .` is not portable — it
 * works in POSIX shells and fails in cmd.exe — and because adding a dependency
 * just to set one environment variable is not worth it.
 *
 *   node scripts/launch-profile.mjs alice
 *   node scripts/launch-profile.mjs bob --project ./.collab-demo/bob
 *
 * A profile gives the instance its own userData directory, which separates its
 * single-instance lock (so a second instance actually starts), its
 * collaboration identity (so it is a different developer) and its settings.
 * See src/main/profile.ts.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [profile, ...rest] = process.argv.slice(2)

if (!profile || profile.startsWith('-')) {
  console.error(
    'Usage: node scripts/launch-profile.mjs <profile-name> [-- electron args]\n' +
      '\n' +
      'Example:\n' +
      '  node scripts/launch-profile.mjs alice\n'
  )
  process.exit(1)
}

if (!existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error(
    'The app has not been built yet. Run `npm run build` first — a profiled\n' +
      'instance runs the built output rather than the dev server, so that two\n' +
      'instances do not fight over one Vite port.'
  )
  process.exit(1)
}

// Resolved rather than assumed to be on PATH.
const electron = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
)

if (!existsSync(electron)) {
  console.error('Could not find the electron binary in node_modules/.bin.')
  process.exit(1)
}

console.log(`Starting Cartograph as profile "${profile}".`)

const child = spawn(electron, ['.', ...rest.filter((arg) => arg !== '--')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CARTOGRAPH_PROFILE: profile },
  // `electron.cmd` is a batch file, which Windows will only run through a shell.
  shell: process.platform === 'win32'
})

child.on('exit', (code) => {
  process.exitCode = code ?? 0
})
