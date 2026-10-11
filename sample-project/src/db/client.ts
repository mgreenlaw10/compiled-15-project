import { logger } from '../utils/logger.ts'
import type { Order, Session, User } from '../types/index.ts'

/** In-memory tables. A real service would talk to a database here. */
interface Tables {
  users: Map<string, User>
  sessions: Map<string, Session>
  orders: Map<string, Order>
}

/**
 * The single point of data access. Everything that touches persisted state
 * goes through an instance of this class.
 */
export class Database {
  private readonly tables: Tables = {
    users: new Map(),
    sessions: new Map(),
    orders: new Map()
  }

  private connected = false

  connect(): void {
    this.connected = true
    logger.debug('database connected')
  }

  close(): void {
    this.connected = false
    logger.debug('database closed')
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('Database is not connected')
  }

  insert<K extends keyof Tables>(
    table: K,
    id: string,
    row: Tables[K] extends Map<string, infer V> ? V : never
  ): void {
    this.assertConnected()
    ;(this.tables[table] as Map<string, unknown>).set(id, row)
  }

  get<K extends keyof Tables>(
    table: K,
    id: string
  ): (Tables[K] extends Map<string, infer V> ? V : never) | undefined {
    this.assertConnected()
    return (this.tables[table] as Map<string, unknown>).get(id) as
      | (Tables[K] extends Map<string, infer V> ? V : never)
      | undefined
  }

  remove<K extends keyof Tables>(table: K, id: string): boolean {
    this.assertConnected()
    return (this.tables[table] as Map<string, unknown>).delete(id)
  }

  all<K extends keyof Tables>(
    table: K
  ): (Tables[K] extends Map<string, infer V> ? V : never)[] {
    this.assertConnected()
    return [...(this.tables[table] as Map<string, unknown>).values()] as (Tables[K] extends Map<
      string,
      infer V
    >
      ? V
      : never)[]
  }
}

/** The process-wide database handle used by the query modules. */
export const database = new Database()
