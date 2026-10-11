/**
 * Deterministic executors for the module-level operations: creating, renaming,
 * and deleting a module, and moving a file between modules.
 *
 * These are the operations the MVP guarantees end to end. Everything they do is
 * a compiler-aware source transformation — a real file move plus a real import
 * rewrite — never a regenerated file.
 */

import type {
  AddModuleOperation,
  DeleteModuleOperation,
  GraphOperation,
  MoveFileOperation,
  RenameModuleOperation
} from '../../../shared/types/operations'
import { findModule } from '../../../shared/graph/model'
import {
  projectedMoveTarget,
  projectedPathAfterDirectoryRename
} from '../../../shared/graph/apply-operation'
import { basename, isWithin, join, normalizeRel } from '../../../shared/util/paths'
import { applyMovesWithImportRewrite, findImporters } from '../imports'
import { failed, metadataOnly, ok, type OpContext, type OpResult } from './context'

/** Files that make sense as the entry file of a freshly created module. */
const BARREL_FILENAME = 'index.ts'

function header(
  name: string,
  description: string,
  responsibilities: string[]
): string {
  const lines = [`/**`, ` * ${name}`]
  if (description.trim() !== '') {
    lines.push(' *', ...wrap(description, 74).map((l) => ` * ${l}`))
  }
  if (responsibilities.length > 0) {
    lines.push(' *', ' * Responsibilities:')
    for (const r of responsibilities) lines.push(` *  - ${r}`)
  }
  lines.push(' */')
  return lines.join('\n')
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current === '') current = word
    else if (`${current} ${word}`.length <= width) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/**
 * The placeholder a declared-but-unimplemented export becomes.
 *
 * It throws rather than returning a plausible value, and the message says
 * exactly where it came from. A silent stub would be a lie about the state of
 * the code; this one compiles, is callable, and fails loudly.
 */
function stubFor(symbol: string, moduleName: string): string {
  return [
    `/** Declared in the architecture graph; not implemented yet. */`,
    `export function ${symbol}(..._args: unknown[]): never {`,
    `  throw new Error(`,
    `    '${symbol} was declared as part of the ${moduleName} module in the architecture graph, but has no implementation yet.'`,
    `  )`,
    `}`
  ].join('\n')
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export function executeAddModule(
  op: AddModuleOperation & GraphOperation,
  ctx: OpContext
): OpResult {
  const target = findModule(ctx.nextGraph, op.module.id)
  if (!target) return failed(`Module ${op.module.id} is not in the graph`)

  if (!op.module.directory) {
    return metadataOnly(
      `Created "${op.module.name}" in the graph only: it has no directory, so there is nothing to write. Give it a directory to generate source files.`
    )
  }

  const directory = normalizeRel(op.module.directory)
  const barrel = join(directory, BARREL_FILENAME)
  if (ctx.workspace.exists(barrel)) {
    return metadataOnly(
      `"${op.module.name}" maps to ${directory}, which already contains ${BARREL_FILENAME}; left the existing file untouched.`
    )
  }

  const declared = op.module.publicInterface.filter((s) => IDENTIFIER.test(s))
  const skipped = op.module.publicInterface.filter((s) => !IDENTIFIER.test(s))

  const parts = [
    header(op.module.name, op.module.description, op.module.responsibilities)
  ]
  if (declared.length === 0) {
    parts.push(
      '// No exports were declared for this module in the graph yet.',
      'export {}'
    )
  } else {
    parts.push(...declared.map((s) => stubFor(s, op.module.name)))
  }

  const content = `${parts.join('\n\n')}\n`
  ctx.workspace.create(barrel, content, {
    reason: `Create module "${op.module.name}"`,
    operationId: op.id
  })

  const warnings: string[] = []
  if (declared.length > 0) {
    warnings.push(
      `${barrel} contains ${declared.length} placeholder export(s) that throw when called: ${declared.join(', ')}. Use "Generate implementation" or write them by hand.`
    )
  }
  if (skipped.length > 0) {
    warnings.push(
      `Skipped ${skipped.length} declared export name(s) that are not valid identifiers: ${skipped.join(', ')}.`
    )
  }

  return ok(
    `Created ${barrel} for module "${op.module.name}"${
      declared.length > 0 ? ` with ${declared.length} placeholder export(s)` : ''
    }.`,
    [barrel],
    { warnings }
  )
}

export function executeRenameModule(
  op: RenameModuleOperation & GraphOperation,
  ctx: OpContext
): OpResult {
  const before = findModule(ctx.graph, op.moduleId)
  if (!before) return failed(`Module ${op.moduleId} is not in the graph`)

  const oldDir = before.directory
  const newDir =
    op.directory === undefined || op.directory === null
      ? null
      : normalizeRel(op.directory)

  if (newDir === null || oldDir === null || newDir === oldDir) {
    return metadataOnly(
      `Renamed "${before.name}" to "${op.name}" in the graph. No files moved${
        oldDir === null
          ? ' (the module is not backed by a directory)'
          : newDir === oldDir
            ? ' (its directory is unchanged)'
            : ''
      }.`
    )
  }

  const moves = new Map<string, string>()
  const outside: string[] = []
  for (const file of before.files) {
    const current = ctx.workspace.currentPathOf(file) ?? file
    if (!ctx.workspace.exists(current)) continue
    if (!isWithin(oldDir, current)) {
      outside.push(current)
      continue
    }
    const to = projectedPathAfterDirectoryRename(current, oldDir, newDir)
    if (to !== current) moves.set(current, to)
  }

  if (moves.size === 0) {
    return metadataOnly(
      `Renamed "${before.name}" to "${op.name}". No files needed moving.`
    )
  }

  const report = applyMovesWithImportRewrite(ctx.workspace, moves, {
    reason: `Rename module "${before.name}" to "${op.name}" (${oldDir} -> ${newDir})`,
    operationId: op.id
  })

  const warnings: string[] = []
  if (outside.length > 0) {
    warnings.push(
      `${outside.length} file(s) in this module live outside ${oldDir} and were left where they are: ${outside.join(', ')}.`
    )
  }
  for (const u of report.unresolved) {
    warnings.push(
      `${u.file}:${u.line} imports "${u.specifier}", which could not be resolved, so it was left unchanged and may now be broken.`
    )
  }

  return ok(
    `Moved ${moves.size} file(s) from ${oldDir} to ${newDir} and rewrote ${report.rewritten} import specifier(s) across ${report.touched.length} file(s).`,
    report.touched,
    { warnings }
  )
}

export function executeMoveFile(
  op: MoveFileOperation & GraphOperation,
  ctx: OpContext
): OpResult {
  const from = findModule(ctx.graph, op.fromModuleId)
  const to = findModule(ctx.graph, op.toModuleId) ?? findModule(ctx.nextGraph, op.toModuleId)
  if (!from) return failed(`Module ${op.fromModuleId} is not in the graph`)
  if (!to) return failed(`Module ${op.toModuleId} is not in the graph`)

  const logical = normalizeRel(op.file)
  const current = ctx.workspace.currentPathOf(logical) ?? logical
  if (!ctx.workspace.exists(current)) {
    return failed(`${logical} does not exist in the project`)
  }

  const target = normalizeRel(projectedMoveTarget(current, to, op.toPath))
  if (target === current) {
    return metadataOnly(
      `${logical} now belongs to "${to.name}" in the graph, but stays at the same path${
        to.directory === null ? ' because the target module has no directory' : ''
      }.`
    )
  }
  if (ctx.workspace.exists(target)) {
    return failed(`Cannot move ${current} to ${target}: a file is already there`)
  }

  // Who referenced the file before it moved? Used below to explain what the
  // rewrite had to touch, and to spot barrels left pointing across modules.
  const importersBefore = findImporters(ctx.workspace, current)

  const report = applyMovesWithImportRewrite(
    ctx.workspace,
    new Map([[current, target]]),
    {
      reason: `Move ${basename(current)} from "${from.name}" to "${to.name}"`,
      operationId: op.id
    }
  )

  const warnings: string[] = []
  const breakingChanges: string[] = []

  for (const importer of importersBefore) {
    const owner = ctx.graph.modules.find((m) => m.files.includes(importer.file))
    if (owner && owner.id === from.id && basename(importer.file) === BARREL_FILENAME) {
      warnings.push(
        `${importer.file} still re-exports the moved file, so "${from.name}" now imports from "${to.name}". Remove that re-export if the modules should be independent.`
      )
    }
  }
  for (const u of report.unresolved) {
    breakingChanges.push(
      `${u.file}:${u.line} imports "${u.specifier}", which does not resolve; it was left unchanged and may be broken.`
    )
  }

  return ok(
    `Moved ${current} to ${target} and rewrote ${report.rewritten} import specifier(s) in ${report.touched.length} file(s).`,
    report.touched,
    { warnings, breakingChanges }
  )
}

export function executeDeleteModule(
  op: DeleteModuleOperation & GraphOperation,
  ctx: OpContext
): OpResult {
  const target = findModule(ctx.graph, op.moduleId)
  if (!target) return failed(`Module ${op.moduleId} is not in the graph`)

  const existing = target.files
    .map((f) => ctx.workspace.currentPathOf(f) ?? f)
    .filter((f) => ctx.workspace.exists(f))

  if (op.fileDisposition === 'orphan') {
    return metadataOnly(
      `Removed "${target.name}" from the graph. Its ${existing.length} file(s) were left in place and are now unassigned.`
    )
  }

  if (op.fileDisposition === 'reassign') {
    const dest =
      findModule(ctx.graph, op.reassignTo ?? '') ??
      findModule(ctx.nextGraph, op.reassignTo ?? '')
    if (!dest) {
      return failed(`Cannot reassign files: module ${op.reassignTo} is not in the graph`)
    }
    const moves = new Map<string, string>()
    for (const file of existing) {
      const to = normalizeRel(projectedMoveTarget(file, dest))
      if (to !== file && !ctx.workspace.exists(to)) moves.set(file, to)
    }
    if (moves.size === 0) {
      return metadataOnly(
        `Removed "${target.name}" from the graph and reassigned ${existing.length} file(s) to "${dest.name}" without moving them.`
      )
    }
    const report = applyMovesWithImportRewrite(ctx.workspace, moves, {
      reason: `Reassign files from "${target.name}" to "${dest.name}"`,
      operationId: op.id
    })
    return ok(
      `Removed "${target.name}", moved ${moves.size} file(s) into "${dest.name}", and rewrote ${report.rewritten} import specifier(s).`,
      report.touched
    )
  }

  // fileDisposition === 'delete'
  const breakingChanges: string[] = []
  const outsideImporters = new Set<string>()
  for (const file of existing) {
    for (const importer of findImporters(ctx.workspace, file)) {
      if (!existing.includes(importer.file)) {
        outsideImporters.add(`${importer.file} imports ${file}`)
      }
    }
  }
  for (const entry of [...outsideImporters].sort()) {
    breakingChanges.push(
      `${entry}, which is about to be deleted. That import will not compile.`
    )
  }

  for (const file of existing) {
    ctx.workspace.delete(file, {
      reason: `Delete module "${target.name}"`,
      operationId: op.id
    })
  }

  return {
    status: breakingChanges.length > 0 ? 'partial' : 'applied',
    executor: 'deterministic',
    message:
      breakingChanges.length > 0
        ? `Deleted ${existing.length} file(s) from "${target.name}", but ${outsideImporters.size} import(s) elsewhere still reference them.`
        : `Deleted ${existing.length} file(s) belonging to "${target.name}".`,
    touchedPaths: existing.sort(),
    warnings:
      breakingChanges.length > 0
        ? [
            'Deleting a module cannot fix the code that used it. Review the listed imports before applying.'
          ]
        : [],
    breakingChanges
  }
}
