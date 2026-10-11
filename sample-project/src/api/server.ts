import { purgeExpiredSessions } from '../auth/session.ts'
import { logger } from '../utils/logger.ts'
import type { RequestContext, Response } from '../types/index.ts'
import type { RouteDefinition } from './routes.ts'

/**
 * A tiny request dispatcher. It stands in for a real HTTP server so the
 * sample project has an entry point without pulling in dependencies.
 */
export class HttpServer {
  private readonly table = new Map<string, RouteDefinition>()

  register(route: RouteDefinition): this {
    this.table.set(`${route.method} ${route.path}`, route)
    return this
  }

  registerAll(routes: RouteDefinition[]): this {
    for (const route of routes) this.register(route)
    return this
  }

  get routeCount(): number {
    return this.table.size
  }

  async handle(ctx: RequestContext): Promise<Response> {
    const route = this.table.get(`${ctx.method} ${ctx.path}`)
    if (!route) return { status: 404, body: { error: 'Not found' } }
    try {
      return await route.handler(ctx)
    } catch (error) {
      logger.error(`unhandled error on ${ctx.path}: ${(error as Error).message}`)
      return { status: 500, body: { error: 'Internal error' } }
    }
  }

  /** Housekeeping the server runs on a timer. */
  sweep(): number {
    const purged = purgeExpiredSessions()
    if (purged > 0) logger.info(`purged ${purged} expired session(s)`)
    return purged
  }
}
