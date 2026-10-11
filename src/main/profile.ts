/**
 * Instance profiles.
 *
 * Normally one copy of Cartograph runs per machine and holds a single-instance
 * lock. But collaboration is between *installs*, and demonstrating or testing
 * it on one machine means running two that are genuinely independent — not two
 * windows sharing one identity.
 *
 * Setting `CARTOGRAPH_PROFILE` gives this instance its own `userData`
 * directory, which separates three things at once:
 *
 *   - **The single-instance lock**, which Electron scopes to `userData`. Two
 *     profiles therefore both start instead of the second quitting.
 *   - **The collaboration identity** (`collab-identity.json`), so the two
 *     instances are two developers with two execution hosts rather than one
 *     developer appearing twice.
 *   - **Settings**, including the API key, so a demo profile cannot read or
 *     overwrite the real one.
 *
 * This must run before `requestSingleInstanceLock`, or the lock is taken
 * against the default directory and the second instance still quits.
 */

import { app } from 'electron'
import path from 'node:path'

/** Kept filesystem-safe: this becomes a directory name. */
function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export interface Profile {
  /** `null` when running normally, as a single instance. */
  name: string | null
  userDataDir: string
}

/**
 * Applies `CARTOGRAPH_PROFILE`, if set, and returns what was decided.
 *
 * Call once, at the very top of the main process.
 */
export function applyProfile(): Profile {
  const requested = process.env.CARTOGRAPH_PROFILE?.trim()
  const defaultDir = app.getPath('userData')

  if (!requested) return { name: null, userDataDir: defaultDir }

  const name = sanitize(requested)
  if (name === '') return { name: null, userDataDir: defaultDir }

  // Nested under the normal location rather than somewhere new, so profiles
  // are easy to find and easy to delete.
  const userDataDir = path.join(defaultDir, 'profiles', name)
  app.setPath('userData', userDataDir)

  return { name, userDataDir }
}

/**
 * Window title for a profile.
 *
 * Two identical windows side by side are impossible to tell apart, which makes
 * a collaboration demo actively misleading — so a profiled instance says who
 * it is in its title bar.
 */
export function windowTitle(profile: Profile): string {
  return profile.name ? `Cartograph — ${profile.name}` : 'Cartograph'
}
