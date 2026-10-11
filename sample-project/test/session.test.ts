import assert from 'node:assert/strict'
import { test } from 'node:test'

import { database } from '../src/db/client.ts'
import {
  SESSION_TTL_MS,
  createSession,
  getSession,
  isSessionExpired,
  purgeExpiredSessions,
  revokeSession
} from '../src/auth/session.ts'

database.connect()

test('a new session is valid and retrievable', () => {
  const session = createSession('usr_1')
  assert.equal(session.userId, 'usr_1')
  assert.equal(isSessionExpired(session), false)
  assert.equal(getSession(session.id)?.id, session.id)
})

test('an expired session is not returned', () => {
  const session = createSession('usr_2')
  const later = Date.now() + SESSION_TTL_MS + 1000
  assert.equal(isSessionExpired(session, later), true)
})

test('revoking a session removes it', () => {
  const session = createSession('usr_3')
  assert.equal(revokeSession(session.id), true)
  assert.equal(getSession(session.id), undefined)
})

test('purge removes only expired sessions', () => {
  const fresh = createSession('usr_4')
  const purged = purgeExpiredSessions(Date.now() - SESSION_TTL_MS)
  assert.equal(purged, 0)
  assert.equal(getSession(fresh.id)?.id, fresh.id)
})
