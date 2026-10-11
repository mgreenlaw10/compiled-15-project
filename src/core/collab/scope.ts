/**
 * What a task is allowed to change.
 *
 * Module reservations are advisory coordination, not a security boundary — an
 * agent runs with the user's own privileges and could write anywhere. So scope
 * is enforced where it can actually be checked: against the *real* diff, at
 * integration time, rather than by trusting an agent's account of its edits.
 *
 * The distinction this module keeps is between:
 *
 *   - **in scope** — inside a module the task reserved,
 *   - **out of scope** — inside a module someone else reserved, or a module
 *     this task was never given,
 *   - **shared** — build files, manifests and other global configuration that
 *     belong to no module and affect everyone.
 *
 * Out-of-scope is not automatically fatal; it is surfaced for a human to judge.
 * Shared-configuration changes are always worth a second look because two tasks
 * editing `package.json` will collide even when their modules do not.
 */

import type { ArchitectureGraph, ModuleId } from '../../shared/types/architecture'
import { normalizeRel } from '../../shared/util/paths'

/**
 * Files that belong to the project as a whole.
 *
 * Matched on basename or on a path prefix. Deliberately conservative: a false
 * positive costs a warning, a false negative costs a silent collision.
 */
const SHARED_CONFIG_NAMES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'tsconfig.base.json',
  'jsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'vitest.config.ts',
  'webpack.config.js',
  'rollup.config.js',
  'babel.config.js',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.cjs',
  'eslint.config.js',
  '.prettierrc',
  'Dockerfile',
  'docker-compose.yml',
  'Makefile',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pom.xml',
  'build.gradle',
  'CMakeLists.txt'
]

const SHARED_CONFIG_PREFIXES: readonly string[] = ['.github/', '.circleci/', 'config/']

export function isSharedConfigPath(filePath: string): boolean {
  const normalized = normalizeRel(filePath)
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (SHARED_CONFIG_NAMES.includes(base)) return true
  if (base.startsWith('tsconfig.') && base.endsWith('.json')) return true
  return SHARED_CONFIG_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export interface ModuleScope {
  moduleId: ModuleId
  /** Explicit file list from the graph. */
  files: Set<string>
  /** Directory prefix, when the module is directory-backed. */
  directory: string | null
}

/** The scope a task may write in, built from the modules it was given. */
export function buildScope(
  graph: ArchitectureGraph,
  moduleIds: readonly ModuleId[]
): ModuleScope[] {
  return moduleIds.map((moduleId) => {
    const module = graph.modules.find((m) => m.id === moduleId)
    return {
      moduleId,
      files: new Set((module?.files ?? []).map(normalizeRel)),
      directory: module?.directory ? normalizeRel(module.directory) : null
    }
  })
}

/** `true` when a path falls inside one module's scope. */
export function pathInScope(filePath: string, scope: ModuleScope): boolean {
  const normalized = normalizeRel(filePath)
  if (scope.files.has(normalized)) return true
  // New files count: an agent implementing a module writes files the graph has
  // never seen, and they belong to whichever module owns the directory.
  return scope.directory !== null && normalized.startsWith(`${scope.directory}/`)
}

/** Which module, if any, owns a path. */
export function ownerOf(
  graph: ArchitectureGraph,
  filePath: string
): ModuleId | null {
  const normalized = normalizeRel(filePath)

  for (const module of graph.modules) {
    if (module.files.some((f) => normalizeRel(f) === normalized)) return module.id
  }
  // Fall back to the longest matching directory, so nested modules win over
  // their parents rather than the first one declared.
  let best: { id: ModuleId; length: number } | null = null
  for (const module of graph.modules) {
    if (!module.directory) continue
    const dir = normalizeRel(module.directory)
    if (normalized.startsWith(`${dir}/`) && (!best || dir.length > best.length)) {
      best = { id: module.id, length: dir.length }
    }
  }
  return best?.id ?? null
}

export interface ScopeViolation {
  path: string
  /** The module that actually owns the path, when one does. */
  ownerModuleId: ModuleId | null
  reason: 'other_module' | 'unowned' | 'shared_config'
}

export interface ScopeCheck {
  inScope: string[]
  violations: ScopeViolation[]
  sharedConfig: string[]
  ok: boolean
}

/**
 * Checks a real diff against a task's scope.
 *
 * Called with the paths Git says changed — never with an agent's self-report.
 */
export function checkScope(
  graph: ArchitectureGraph,
  moduleIds: readonly ModuleId[],
  changedPaths: readonly string[]
): ScopeCheck {
  const scopes = buildScope(graph, moduleIds)
  const inScope: string[] = []
  const violations: ScopeViolation[] = []
  const sharedConfig: string[] = []

  for (const raw of changedPaths) {
    const filePath = normalizeRel(raw)

    if (isSharedConfigPath(filePath)) {
      sharedConfig.push(filePath)
      // Reported separately rather than as a violation: a task may legitimately
      // need a dependency, and the risk is collision, not trespass.
      violations.push({ path: filePath, ownerModuleId: null, reason: 'shared_config' })
      continue
    }

    if (scopes.some((scope) => pathInScope(filePath, scope))) {
      inScope.push(filePath)
      continue
    }

    const owner = ownerOf(graph, filePath)
    violations.push({
      path: filePath,
      ownerModuleId: owner,
      reason: owner ? 'other_module' : 'unowned'
    })
  }

  return {
    inScope,
    violations,
    sharedConfig,
    // Shared config alone does not fail the check; writing into someone else's
    // module does.
    ok: violations.every((v) => v.reason === 'shared_config')
  }
}

/** A sentence a user can act on, for the integration report. */
export function describeScopeCheck(check: ScopeCheck, graph: ArchitectureGraph): string {
  if (check.violations.length === 0) {
    return `All ${check.inScope.length} changed file(s) are inside the task's modules.`
  }
  const nameOf = (id: ModuleId | null): string =>
    graph.modules.find((m) => m.id === id)?.name ?? id ?? 'no module'

  const parts: string[] = []
  const trespass = check.violations.filter((v) => v.reason === 'other_module')
  const unowned = check.violations.filter((v) => v.reason === 'unowned')

  if (trespass.length > 0) {
    const modules = [...new Set(trespass.map((v) => nameOf(v.ownerModuleId)))]
    parts.push(
      `${trespass.length} file(s) belong to ${modules.join(', ')}, which this task does not own`
    )
  }
  if (unowned.length > 0) {
    parts.push(`${unowned.length} file(s) belong to no module in the graph`)
  }
  if (check.sharedConfig.length > 0) {
    parts.push(
      `${check.sharedConfig.length} shared configuration file(s) changed (${check.sharedConfig.slice(0, 3).join(', ')})`
    )
  }
  return parts.join('; ')
}
