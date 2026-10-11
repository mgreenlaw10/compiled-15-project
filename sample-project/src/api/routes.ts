import { login, logout } from '../auth/index.ts'
import { getSession } from '../auth/session.ts'
import { createUser, findUserByEmail } from '../db/users.ts'
import { listOrdersForUser } from '../db/orders.ts'
import { hashPassword } from '../auth/password.ts'
import { startCheckout } from '../payments/checkout.ts'
import { logger } from '../utils/logger.ts'
import type { RequestContext, Response, RouteHandler } from '../types/index.ts'

function ok(body: Record<string, unknown>): Response {
  return { status: 200, body }
}

function badRequest(message: string): Response {
  return { status: 400, body: { error: message } }
}

export const postRegister: RouteHandler = async (ctx: RequestContext) => {
  const email = String(ctx.body.email ?? '')
  const password = String(ctx.body.password ?? '')
  const displayName = String(ctx.body.displayName ?? email)
  if (email === '' || password === '') return badRequest('email and password are required')
  if (findUserByEmail(email)) return badRequest('that email is already registered')

  const user = createUser(email, displayName, hashPassword(password))
  return ok({ id: user.id, email: user.email })
}

export const postLogin: RouteHandler = async (ctx: RequestContext) => {
  try {
    const result = login(String(ctx.body.email ?? ''), String(ctx.body.password ?? ''))
    return ok({ token: result.token, sessionId: result.session.id })
  } catch (error) {
    return { status: 401, body: { error: (error as Error).message } }
  }
}

export const deleteSession: RouteHandler = async (ctx: RequestContext) => {
  if (!ctx.sessionId) return badRequest('no session')
  return ok({ loggedOut: logout(ctx.sessionId) })
}

export const getOrders: RouteHandler = async (ctx: RequestContext) => {
  const session = ctx.sessionId ? getSession(ctx.sessionId) : undefined
  if (!session) return { status: 401, body: { error: 'Not signed in' } }
  return ok({ orders: listOrdersForUser(session.userId) })
}

export const postCheckout: RouteHandler = async (ctx: RequestContext) => {
  if (!ctx.sessionId) return badRequest('no session')
  const items = Array.isArray(ctx.body.items) ? ctx.body.items : []
  const order = startCheckout({
    sessionId: ctx.sessionId,
    items: items as { sku: string; priceCents: number; quantity: number }[]
  })
  logger.debug(`checkout completed: ${order.id}`)
  return ok({ order })
}

export interface RouteDefinition {
  method: RequestContext['method']
  path: string
  handler: RouteHandler
}

export const routes: RouteDefinition[] = [
  { method: 'POST', path: '/register', handler: postRegister },
  { method: 'POST', path: '/login', handler: postLogin },
  { method: 'DELETE', path: '/session', handler: deleteSession },
  { method: 'GET', path: '/orders', handler: getOrders },
  { method: 'POST', path: '/checkout', handler: postCheckout }
]
