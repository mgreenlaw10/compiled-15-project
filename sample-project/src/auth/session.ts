import { database } from '../db/client.ts'
import { generateId } from '../utils/ids.ts'
import { logger } from '../utils/logger.ts'
import type { Session } from '../types/index.ts'

/** How long a new session stays valid. */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24

/** Creates a session for a user and stores it. */
export function createSession(userId: string): Session {
  const now = Date.now()
  const session: Session = {
    id: generateId('ses'),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
  }
  database.insert('sessions', session.id, session)
  logger.debug(`session created for ${userId}`)
  return session
}

export function getSession(sessionId: string): Session | undefined {
  const session = database.get('sessions', sessionId)
  if (!session) return undefined
  if (isSessionExpired(session)) {
    revokeSession(sessionId)
    return undefined
  }
  return session
}

export function isSessionExpired(session: Session, now = Date.now()): boolean {
  return Date.parse(session.expiresAt) <= now
}

export function revokeSession(sessionId: string): boolean {
  const removed = database.remove('sessions', sessionId)
  if (removed) logger.debug(`session revoked: ${sessionId}`)
  return removed
}

/** Drops every expired session. Called periodically by the server. */
export function purgeExpiredSessions(now = Date.now()): number {
  const expired = database
    .all('sessions')
    .filter((session) => isSessionExpired(session, now))
  for (const session of expired) database.remove('sessions', session.id)
  return expired.length
}
