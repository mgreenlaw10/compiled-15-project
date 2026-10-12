import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NewType, sayHi } from '../src/index.ts'

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

test('NewType holds a vector of two floats', () => {
  const vector = new NewType(1.5, -2.25)
  assert.equal(vector.x, 1.5)
  assert.equal(vector.y, -2.25)

  const zero = new NewType()
  assert.equal(zero.x, 0)
  assert.equal(zero.y, 0)
})
