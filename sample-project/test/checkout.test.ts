import assert from 'node:assert/strict'
import { test } from 'node:test'

import { database } from '../src/db/client.ts'
import { createSession } from '../src/auth/session.ts'
import { startCheckout, totalFor } from '../src/payments/checkout.ts'

database.connect()

test('totalFor multiplies price by quantity', () => {
  const total = totalFor({
    sessionId: 'ignored',
    items: [
      { sku: 'a', priceCents: 250, quantity: 2 },
      { sku: 'b', priceCents: 100, quantity: 3 }
    ]
  })
  assert.equal(total, 800)
})

test('checkout creates a paid order for the session user', () => {
  const session = createSession('usr_checkout')
  const order = startCheckout({
    sessionId: session.id,
    items: [{ sku: 'a', priceCents: 1000, quantity: 1 }]
  })
  assert.equal(order.userId, 'usr_checkout')
  assert.equal(order.status, 'paid')
  assert.equal(order.totalCents, 1000)
})
