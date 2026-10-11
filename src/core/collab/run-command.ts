/**
 * Running a project-defined command.
 *
 * Isolated in its own module because it is the one place Cartograph executes
 * something it did not write. Everything about it is deliberately narrow: no
 * shell, an explicit argv, a timeout, a capped buffer, and a caller that has
 * already checked the user allowed it.
 *
 * This is not a sandbox. It runs with the user's own privileges, which is why
 * `runValidation` refuses to call it unless collaboration settings explicitly
 * permit running project commands for agent-generated changes.
 */

import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_OUTPUT_CHARS = 200_000

export interface RunCommandOptions {
  command: string
  args: string[]
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CommandResult {
  exitCode: number
  /** stdout and stderr interleaved, capped. */
  output: string
  timedOut: boolean
}

export async function runCommand(
  options: RunCommandOptions
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    let output = ''
    let timedOut = false

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      // No shell: the command and its arguments are data, never a script.
      shell: false,
      windowsHide: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' }
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const onAbort = (): void => {
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort)

    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    child.on('error', (error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        output: output.slice(0, MAX_OUTPUT_CHARS),
        timedOut
      })
    })
  })
}
