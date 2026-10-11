/**
 * Validating a generated project.
 *
 * Writing files successfully says nothing about whether the result compiles, so
 * after generation Cartograph actually runs the project's own checks and
 * reports exactly what happened — including "this check did not run, and here
 * is why". A check that was skipped is never counted as a pass.
 *
 * Type checking prefers the project's own TypeScript installation. When the
 * project has no `node_modules` — which is the common case right after
 * generating into a fresh directory — it falls back to the compiler bundled
 * with Cartograph and says so in the report, because a different compiler
 * version can legitimately give a different answer.
 */

import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import ts from 'typescript'

import type {
  ValidationCheck,
  ValidationReport
} from '../../shared/types/generation'
import { toPosix } from '../../shared/util/paths'
import type { Logger } from '../logger'
import { silentLogger } from '../logger'
import { validateProgram } from './program-validation'

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_OUTPUT_CHARS = 20_000

export interface ValidateOptions {
  logger?: Logger
  timeoutMs?: number
  /** Run the project's `npm test` script. */
  runTests?: boolean
  signal?: AbortSignal
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_OUTPUT_CHARS
    ? `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated …`
    : trimmed
}

interface CommandResult {
  code: number | null
  output: string
  timedOut: boolean
  durationMs: number
  spawnError: string | null
}

/**
 * How to launch a check.
 *
 * `exe` is spawned directly with its arguments as an array — the safe form,
 * used for real executables like `node` and `git`. `commandLine` goes through a
 * shell, which Windows requires for `npm` (a `.cmd` shim that Node refuses to
 * spawn directly). Only fixed literal command lines are ever passed that way,
 * and the working directory travels in the options rather than the string, so
 * no caller-supplied text reaches the shell.
 */
type CommandSpec =
  | { exe: string; args: string[] }
  | { commandLine: string }

function runCommand(
  spec: CommandSpec,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let output = ''
    let timedOut = false
    let settled = false

    const useShell = 'commandLine' in spec
    const child = spawn(
      useShell ? spec.commandLine : spec.exe,
      useShell ? [] : spec.args,
      {
        cwd,
        shell: useShell,
        windowsHide: true,
        env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
      }
    )

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null, spawnError: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        output,
        timedOut,
        durationMs: Date.now() - started,
        spawnError
      })
    }

    child.stdout?.on('data', (d: Buffer) => {
      output += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      output += d.toString()
    })
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code, null))
  })
}

/** Locates the project's own `tsc`, if it has one installed. */
async function findLocalTsc(root: string): Promise<string | null> {
  const candidate = path.join(
    root,
    'node_modules',
    'typescript',
    'bin',
    'tsc'
  )
  return (await exists(candidate)) ? candidate : null
}

async function findTsConfig(root: string): Promise<string | null> {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = path.join(root, name)
    if (await exists(candidate)) return candidate
  }
  return null
}

/**
 * Type checks using the compiler bundled with Cartograph, through the
 * TypeScript API. Used when the project has no TypeScript of its own.
 */
function typecheckWithBundledCompiler(
  configPath: string,
  root: string
): ValidationCheck {
  const started = Date.now()
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {}
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host)

  if (!parsed) {
    return {
      name: 'TypeScript type check',
      command: `typescript@${ts.version} (bundled with Cartograph)`,
      status: 'failed',
      exitCode: null,
      durationMs: Date.now() - started,
      output: `Could not read ${toPosix(configPath)}.`
    }
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
    projectReferences: parsed.projectReferences
  })
  const diagnostics = [
    ...program.getConfigFileParsingDiagnostics(),
    ...ts.getPreEmitDiagnostics(program)
  ].filter((d) => d.category === ts.DiagnosticCategory.Error)

  const formatted = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n'
  })

  return {
    name: 'TypeScript type check',
    command: `typescript@${ts.version} (bundled with Cartograph)`,
    status: diagnostics.length === 0 ? 'passed' : 'failed',
    exitCode: diagnostics.length === 0 ? 0 : 1,
    durationMs: Date.now() - started,
    output:
      diagnostics.length === 0
        ? `No type errors in ${parsed.fileNames.length} file(s).`
        : clip(formatted),
    note:
      'Ran with the TypeScript version bundled with Cartograph because the project has no local installation; the project’s own compiler version may report differently.'
  }
}

async function readPackageScripts(
  root: string
): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
    return pkg.scripts ?? {}
  } catch {
    return {}
  }
}

export async function validateProject(
  root: string,
  options: ValidateOptions = {}
): Promise<ValidationReport> {
  const logger = options.logger ?? silentLogger
  const log = logger.child('validation')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const checks: ValidationCheck[] = []

  // ---- Type checking -----------------------------------------------------
  const configPath = await findTsConfig(root)
  if (!configPath) {
    checks.push({
      name: 'TypeScript type check',
      command: 'tsc --noEmit',
      status: 'skipped',
      exitCode: null,
      durationMs: 0,
      output: '',
      note: 'No tsconfig.json or jsconfig.json found in the project.'
    })
  } else {
    const localTsc = await findLocalTsc(root)
    if (localTsc) {
      log.info('Type checking with the project’s own TypeScript')
      const run = await runCommand(
        { exe: process.execPath, args: [localTsc, '--noEmit', '-p', configPath] },
        root,
        timeoutMs,
        options.signal
      )
      checks.push({
        name: 'TypeScript type check',
        command: 'node node_modules/typescript/bin/tsc --noEmit',
        status: run.timedOut
          ? 'timeout'
          : run.spawnError !== null
            ? 'failed'
            : run.code === 0
              ? 'passed'
              : 'failed',
        exitCode: run.code,
        durationMs: run.durationMs,
        output: run.spawnError
          ? `Could not start the compiler: ${run.spawnError}`
          : clip(run.output) || 'No output.',
        ...(run.timedOut
          ? { note: `Stopped after ${Math.round(timeoutMs / 1000)}s.` }
          : {})
      })
    } else {
      log.info('Type checking with the bundled TypeScript compiler')
      try {
        checks.push(typecheckWithBundledCompiler(configPath, root))
      } catch (error) {
        checks.push({
          name: 'TypeScript type check',
          command: `typescript@${ts.version} (bundled with Cartograph)`,
          status: 'failed',
          exitCode: null,
          durationMs: 0,
          output: `The type check could not run: ${(error as Error).message}`
        })
      }
    }
  }

  // ---- Tests -------------------------------------------------------------
  const scripts = await readPackageScripts(root)
  const hasTestScript =
    typeof scripts.test === 'string' && scripts.test.trim() !== ''

  if (options.runTests === false) {
    checks.push({
      name: 'Project tests',
      command: 'npm test',
      status: 'skipped',
      exitCode: null,
      durationMs: 0,
      output: '',
      note: 'Test execution was turned off for this run.'
    })
  } else if (!hasTestScript) {
    checks.push({
      name: 'Project tests',
      command: 'npm test',
      status: 'skipped',
      exitCode: null,
      durationMs: 0,
      output: '',
      note: 'The project has no "test" script in package.json.'
    })
  } else {
    const hasModules = await exists(path.join(root, 'node_modules'))
    log.info(`Running the project’s tests: npm test (${scripts.test})`)
    const run = await runCommand(
      { commandLine: 'npm test --silent' },
      root,
      timeoutMs,
      options.signal
    )
    checks.push({
      name: 'Project tests',
      command: `npm test  (${scripts.test})`,
      status: run.timedOut
        ? 'timeout'
        : run.spawnError !== null
          ? 'failed'
          : run.code === 0
            ? 'passed'
            : 'failed',
      exitCode: run.code,
      durationMs: run.durationMs,
      output: run.spawnError
        ? `Could not start npm: ${run.spawnError}`
        : clip(run.output) || 'No output.',
      ...(hasModules
        ? {}
        : {
            note: 'This project has no node_modules directory, so the test script ran without its dependencies installed.'
          })
    })
  }

  checks.push(...await validateProgram(root, runCommand, timeoutMs, options.runTests !== false, options.signal))
  const ran = checks.filter((c) => c.status !== 'skipped')
  const failures = ran.filter((c) => c.status !== 'passed')
  const passed = ran.length > 0 && failures.length === 0

  const summary =
    ran.length === 0
      ? 'No checks could be run, so the generated project is unverified.'
      : failures.length === 0
        ? `${ran.length} check(s) passed: ${ran.map((c) => c.name).join(', ')}.`
        : `${failures.length} of ${ran.length} check(s) did not pass: ${failures
            .map((c) => `${c.name} (${c.status})`)
            .join(', ')}.`

  if (passed) log.success(summary)
  else if (ran.length === 0) log.warn(summary)
  else log.error(summary)

  return { projectRoot: root, checks, passed, summary }
}
