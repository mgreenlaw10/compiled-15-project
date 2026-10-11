import { createOrder, setOrderStatus } from '../db/orders.ts'
import { logger } from '../utils/logger.ts'
import { getSession } from '../auth/session.ts'
import type { Order } from '../types/index.ts'

export interface CheckoutRequest {
  sessionId: string
  items: { sku: string; priceCents: number; quantity: number }[]
}

export function totalFor(request: CheckoutRequest): number {
  return request.items.reduce(
    (sum, item) => sum + item.priceCents * item.quantity,
    0
  )
}

/** Creates an order for the session's user and marks it paid. */
export function startCheckout(request: CheckoutRequest): Order {
  const session = getSession(request.sessionId)
  if (!session) throw new Error('Not signed in')

  const order = createOrder(session.userId, totalFor(request))
  logger.info(`order ${order.id} created for ${session.userId}`)
  return setOrderStatus(order.id, 'paid')
}

export function refund(orderId: string): Order {
  logger.info(`refunding ${orderId}`)
  return setOrderStatus(orderId, 'refunded')
}
