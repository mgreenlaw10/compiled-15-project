import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sayHi } from '../src/index.ts'

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
