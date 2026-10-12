/** Launch two independent Cartograph instances using the existing profiles. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

if (args.includes('--help')) {
  console.log('Usage: node scripts/launch-two.mjs [profile-one profile-two]\nDefaults: alice bob. Run npm run start:two to build and launch both.')
  process.exit(0)
}

const profiles = args.length ? args : ['alice', 'bob']
if (profiles.length !== 2 || profiles.some((name) => !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name)) || profiles[0] === profiles[1]) {
  console.error('Provide two distinct profile names: 1–40 lowercase letters, numbers, dots, underscores or hyphens, starting with a letter or number.')
  process.exit(1)
}
if (!existsSync(path.join(root, 'out/main/index.js')) || !existsSync(electron)) {
  console.error('Install dependencies and build first, or use npm run start:two.')
  process.exit(1)
}

for (const profile of profiles) {
  const env = { ...process.env, CARTOGRAPH_PROFILE: profile }
  // Launch the built renderer even when called from a development terminal.
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [root], {
    cwd: root, env, detached: true, stdio: 'ignore', windowsHide: false
  })
  child.on('error', (error) => {
    console.error(`Could not launch ${profile}: ${error.message}`)
    process.exitCode = 1
  })
  child.once('spawn', () => console.log(`Opened Cartograph (${profile}).`))
  child.unref()
}
