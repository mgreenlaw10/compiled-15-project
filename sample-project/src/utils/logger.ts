/** Minimal leveled logger. */

export type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LoggerOptions {
  minimumLevel: Level
  sink: (line: string) => void
}

export class Logger {
  private readonly options: LoggerOptions

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = {
      minimumLevel: options.minimumLevel ?? 'info',
      sink: options.sink ?? ((line) => console.log(line))
    }
  }

  log(level: Level, message: string): void {
    if (ORDER[level] < ORDER[this.options.minimumLevel]) return
    this.options.sink(`[${level}] ${message}`)
  }

  debug(message: string): void {
    this.log('debug', message)
  }

  info(message: string): void {
    this.log('info', message)
  }

  warn(message: string): void {
    this.log('warn', message)
  }

  error(message: string): void {
    this.log('error', message)
  }
}

export const logger = new Logger()
