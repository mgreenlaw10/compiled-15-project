/** Shared types used across the service. */

export interface User {
  id: string
  email: string
  displayName: string
  passwordHash: string
  createdAt: string
}

export interface Session {
  id: string
  userId: string
  createdAt: string
  expiresAt: string
}

export interface Order {
  id: string
  userId: string
  totalCents: number
  status: OrderStatus
  createdAt: string
}

export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'failed'

export interface RequestContext {
  path: string
  method: 'GET' | 'POST' | 'DELETE'
  body: Record<string, unknown>
  sessionId: string | null
}

export interface Response {
  status: number
  body: Record<string, unknown>
}

export type RouteHandler = (ctx: RequestContext) => Promise<Response>
