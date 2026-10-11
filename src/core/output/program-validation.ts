import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ValidationCheck } from '../../shared/types/generation'
import { scanProject } from '../analyzer/scan'

interface Result { code: number | null; output: string; timedOut: boolean; durationMs: number; spawnError: string | null }
export type RunCheck = (spec: { exe: string; args: string[] }, root: string, timeout: number, signal?: AbortSignal) => Promise<Result>
interface ValidationConfig { javaTestClasses?: string[]; cTestSources?: string[]; checks?: { name: string; exe: string; args: string[]; kind: 'tests' | 'contracts' }[] }

export async function validateProgram(root: string, run: RunCheck, timeout: number, runTests = true, signal?: AbortSignal): Promise<ValidationCheck[]> {
  const scan = await scanProject(root)
  const checks: ValidationCheck[] = []
  const java = scan.files.filter((f) => f.language === 'java')
  const c = scan.files.filter((f) => f.path.endsWith('.c'))
  const cpp = scan.files.filter((f) => f.language === 'cpp' && !/\.(hpp|hxx|hh|ipp|tpp)$/.test(f.path))
  const python = scan.files.filter((f) => f.language === 'python')
  if (!scan.files.some((f) => ['java', 'c', 'cpp', 'python'].includes(f.language))) return checks
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-validation-'))
  let config: ValidationConfig = {}
  try {
    try { config = JSON.parse(await fs.readFile(path.join(root, 'cartograph.validation.json'), 'utf8')) as ValidationConfig }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') checks.push({ name: 'Validation configuration', command: 'read cartograph.validation.json',
        status: 'failed', exitCode: null, durationMs: 0, output: (error as Error).message })
    }
    const check = async (name: string, exe: string, args: string[], note?: string): Promise<ValidationCheck> => {
      const result = await run({ exe, args }, root, timeout, signal)
      const unavailable = result.spawnError?.includes('ENOENT')
      const record: ValidationCheck = { name, command: [exe, ...args].join(' '),
        status: unavailable ? 'skipped' : result.timedOut ? 'timeout' : result.code === 0 && !result.spawnError ? 'passed' : 'failed',
        exitCode: result.code, durationMs: result.durationMs, output: (result.spawnError ?? result.output).slice(0, 20000),
        note: unavailable ? `${exe} is unavailable. Install the project toolchain and run this check again.` : note }
      checks.push(record)
      return record
    }
    if (java.length) {
      const compile = await check('Java compilation', 'javac', ['-d', dir, ...java.map((f) => f.absolutePath)],
        'Uses the available JDK and analyzed sources. Projects with external dependencies may need configured Maven/Gradle checks.')
      if (runTests && compile.status === 'passed') for (const test of config.javaTestClasses ?? []) {
        await check(`Java tests: ${test}`, 'java', ['-ea', '-cp', dir, test], 'Assertions enabled for this test execution; passing tests are not a universal contract proof.')
      }
    }
    if (python.length) await check('Python syntax', 'python', ['-c',
      'import ast,sys,tokenize; [ast.parse(tokenize.open(p).read(), filename=p) for p in sys.argv[1:]]', ...python.map((f) => f.absolutePath)],
      'Parses Python sources without importing or executing the project. Configure test commands to check behavior.')
    for (const [files, exe, name] of [[c, 'gcc', 'C compilation'], [cpp, 'g++', 'C++ compilation']] as const) {
      if (files.length) await check(name, exe, ['-fsyntax-only', '-I', root, '-I', path.join(root, 'include'), '-I', path.join(root, 'src'), ...files.map((f) => f.absolutePath)],
        'Syntax/type checking with conventional include paths. Use configured checks for the full project build and linker validation.')
    }
    if (runTests && config.cTestSources?.length) {
      const exe = path.join(dir, process.platform === 'win32' ? 'program-tests.exe' : 'program-tests')
      const compiled = await check('C test build', 'gcc', ['-I', root, '-I', path.join(root, 'include'), ...config.cTestSources, '-o', exe])
      if (compiled.status === 'passed') await check('C contract tests', exe, [], 'Passing these assertions supports only the exercised cases.')
    }
    for (const custom of config.checks ?? []) {
      if (!runTests || !custom.name || !custom.exe || !Array.isArray(custom.args)) continue
      await check(custom.name, custom.exe, custom.args, `${custom.kind} check configured by this project. No formal behavioral proof is implied.`)
    }
    checks.push({ name: 'Behavioral contract verification', command: 'contract verification', status: 'skipped', exitCode: null, durationMs: 0, output: '',
      note: 'Contracts remain specifications. Runtime assertions and configured tests provide limited evidence; compilation does not prove behavioral compatibility.' })
    return checks
  } finally {
    const resolved = path.resolve(dir)
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(resolved, { recursive: true, force: true })
  }
}
