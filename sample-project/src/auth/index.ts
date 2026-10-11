/** Public surface of the authentication module. */

export { login, logout, type LoginResult } from './login.ts'
export { hashPassword, verifyPassword } from './password.ts'
export { signToken, verifyToken } from './tokens.ts'
export {
  SESSION_TTL_MS,
  createSession,
  getSession,
  isSessionExpired,
  purgeExpiredSessions,
  revokeSession
} from './session.ts'
