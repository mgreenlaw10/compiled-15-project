import { database } from './client.ts'
import { generateId } from '../utils/ids.ts'
import type { Order, OrderStatus } from '../types/index.ts'

export function createOrder(userId: string, totalCents: number): Order {
  const order: Order = {
    id: generateId('ord'),
    userId,
    totalCents,
    status: 'pending',
    createdAt: new Date().toISOString()
  }
  database.insert('orders', order.id, order)
  return order
}

export function setOrderStatus(id: string, status: OrderStatus): Order {
  const order = database.get('orders', id)
  if (!order) throw new Error(`No such order: ${id}`)
  const updated: Order = { ...order, status }
  database.insert('orders', id, updated)
  return updated
}

export function listOrdersForUser(userId: string): Order[] {
  return database.all('orders').filter((order) => order.userId === userId)
}
