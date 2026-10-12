import assert from 'node:assert/strict'
import { test } from 'node:test'

import { database } from '../src/db/client.ts'
import { createUser } from '../src/db/users.ts'
import { hashPassword, login, logout, verifyToken } from '../src/auth/index.ts'

database.connect()

test('login returns a session and a verifiable token', () => {
  createUser('ada@example.com', 'Ada', hashPassword('correct horse'))
  const result = login('ada@example.com', 'correct horse')
  assert.equal(result.user.email, 'ada@example.com')
  assert.equal(verifyToken(result.token), result.session.id)
  assert.equal(logout(result.session.id), true)
})

test('login rejects a wrong password', () => {
  createUser('grace@example.com', 'Grace', hashPassword('hopper'))
  assert.throws(() => login('grace@example.com', 'nope'), /Invalid credentials/)
})

/** Prints hi to the console. */
export function sayHi(): void {
  console.log('hi')
}

test('sayHi prints hi to the console', () => {
  const original = console.log
  const lines: unknown[] = []
  console.log = (...data: unknown[]) => {
    lines.push(...data)
  }
  try {
    sayHi()
  } finally {
    console.log = original
  }
  assert.deepEqual(lines, ['hi'])
})
