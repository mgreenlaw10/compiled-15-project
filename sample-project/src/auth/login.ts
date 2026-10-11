import { findUserByEmail } from '../db/users.ts'
import { logger } from '../utils/logger.ts'
import { verifyPassword } from './password.ts'
import { createSession, revokeSession } from './session.ts'
import { signToken } from './tokens.ts'
import type { Session, User } from '../types/index.ts'

export interface LoginResult {
  user: User
  session: Session
  token: string
}

/** Authenticates a user and opens a session for them. */
export function login(email: string, password: string): LoginResult {
  const user = findUserByEmail(email)
  if (!user) {
    logger.warn(`login failed: no user for ${email}`)
    throw new Error('Invalid credentials')
  }
  if (!verifyPassword(password, user.passwordHash)) {
    logger.warn(`login failed: bad password for ${email}`)
    throw new Error('Invalid credentials')
  }

  const session = createSession(user.id)
  logger.info(`login succeeded for ${user.email}`)
  return { user, session, token: signToken(session.id) }
}

/** Ends a session. */
export function logout(sessionId: string): boolean {
  return revokeSession(sessionId)
}
