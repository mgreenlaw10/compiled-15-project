import { HttpServer } from './api/server.ts'
import { routes } from './api/routes.ts'
import { database } from './db/client.ts'
import { logger } from './utils/logger.ts'

/** Builds a fully wired server instance. */
export function createApp(): HttpServer {
  database.connect()
  const server = new HttpServer().registerAll(routes)
  logger.info(`shop-api ready with ${server.routeCount} route(s)`)
  return server
}

export function shutdown(): void {
  database.close()
}

/** Prints hi to the console. */
export function sayHi(): void {
  console.log('hi')
}
