/**
 * The operation reducer: `(graph, operation) -> graph`.
 *
 * This is the single place where the architecture changes shape. It is pure and
 * immutable, which buys three things:
 *
 *   - the GUI can keep the original graph next to the desired one and diff them,
 *   - operations can be replayed in order to rebuild the desired graph from a
 *     log (the mechanism a shared/multiplayer backend would use),
 *   - and the transformation engine can walk the same operations in the same
 *     order against real files, confident the two views stay in step.
 *
 * File-path rewriting lives here too (`projectedPathAfterDirectoryRename`) so
 * that the graph's idea of where a file will end up matches what the engine
 * actually does on disk.
 */

import type { ArchitectureGraph, ModuleNode } from '../types/architecture'
import type { GraphOperation, GraphOperationBody } from '../types/operations'
import { basename, isWithin, join, normalizeRel } from '../util/paths'
import { createEdge, createModule, findModule } from './model'
import { applyProgramOperation } from './program-operations'
import { refreshComponents } from './program'

export interface ApplyResultOk {
  ok: true
  graph: ArchitectureGraph
  warnings: string[]
}

export interface ApplyResultErr {
  ok: false
  error: string
}

export type ApplyOperationResult = ApplyResultOk | ApplyResultErr

/**
 * Where a file ends up when its enclosing directory is renamed.
 * Exported because the transformation engine needs the exact same answer.
 */
export function projectedPathAfterDirectoryRename(
  file: string,
  oldDir: string,
  newDir: string
): string {
  if (!isWithin(oldDir, file)) return file
  const rest = oldDir === '' ? file : file.slice(oldDir.length + 1)
  return join(newDir, rest)
}

/** Destination path for a file moved into `target`. */
export function projectedMoveTarget(
  file: string,
  target: ModuleNode,
  explicitPath?: string
): string {
  if (explicitPath) return normalizeRel(explicitPath)
  if (target.directory) return join(target.directory, basename(file))
  // Not directory-backed: the file keeps its path and only changes owner.
  return file
}

function bumpModule(m: ModuleNode, patch: Partial<ModuleNode>): ModuleNode {
  return { ...m, ...patch, version: m.version + 1 }
}

function withModules(
  graph: ArchitectureGraph,
  modules: ModuleNode[]
): ArchitectureGraph {
  const nextFiles = new Set(modules.flatMap((m) => m.files))
  const moved = new Map<string, string>()
  for (const file of graph.modules.flatMap((m) => m.files)) {
    if (nextFiles.has(file)) continue
    const candidates = [...nextFiles].filter((f) => basename(f) === basename(file))
    if (candidates.length === 1) moved.set(file, candidates[0])
  }
  const retarget = <T extends { file: string }>(source: T): T => ({ ...source, file: moved.get(source.file) ?? source.file })
  const program = { ...graph.program,
    symbols: graph.program.symbols.map((s) => ({ ...s, source: retarget(s.source), nameSource: retarget(s.nameSource), signatureSource: retarget(s.signatureSource),
      bodySource: s.bodySource ? retarget(s.bodySource) : undefined, fields: s.fields.map((f) => ({ ...f, source: retarget(f.source) })) })),
    relationships: graph.program.relationships.map((r) => ({ ...r, source: retarget(r.source), targetSource: r.targetSource ? retarget(r.targetSource) : undefined })),
    contracts: graph.program.contracts.map((c) => ({ ...c, evidence: c.evidence.map(retarget), enforcement: c.enforcement ? { ...c.enforcement, expressionSource: retarget(c.enforcement.expressionSource) } : undefined })),
    fileRelationships: graph.program.fileRelationships.map((r) => ({ ...r, fromFile: moved.get(r.fromFile) ?? r.fromFile, toFile: moved.get(r.toFile) ?? r.toFile })) }
  return refreshComponents({ ...graph, modules, program, version: graph.version + 1 })
}

export function applyOperation(
  graph: ArchitectureGraph,
  op: GraphOperationBody
): ApplyOperationResult {
  const warnings: string[] = []
  const programResult = applyProgramOperation(graph, op)
  if (programResult) return programResult

  switch (op.type) {
    case 'add_module': {
      if (findModule(graph, op.module.id)) {
        return {
          ok: false,
          error: `A module with id "${op.module.id}" already exists`
        }
      }
      const node = createModule({
        id: op.module.id,
        name: op.module.name,
        description: op.module.description,
        responsibilities: op.module.responsibilities,
        directory: op.module.directory,
        publicInterface: op.module.publicInterface,
        origin: 'user',
        confidence: 1,
        confidenceBasis: 'user',
        notes: ['Created in the graph editor; no source files yet.']
      })
      return {
        ok: true,
        graph: withModules(graph, [...graph.modules, node]),
        warnings
      }
    }

    case 'rename_module': {
      const target = findModule(graph, op.moduleId)
      if (!target) return { ok: false, error: `Module not found: ${op.moduleId}` }
      if (op.name.trim() === '') {
        return { ok: false, error: 'Module name cannot be empty' }
      }

      let files = target.files
      let symbols = target.symbols
      let directory = target.directory
      if (op.directory !== undefined && op.directory !== target.directory) {
        const oldDir = target.directory
        directory = op.directory === null ? null : normalizeRel(op.directory)
        if (oldDir !== null && directory !== null) {
          const newDir = directory
          files = target.files.map((f) =>
            projectedPathAfterDirectoryRename(f, oldDir, newDir)
          )
          symbols = target.symbols.map((s) => ({
            ...s,
            file: projectedPathAfterDirectoryRename(s.file, oldDir, newDir)
          }))
          const outside = target.files.filter((f) => !isWithin(oldDir, f))
          if (outside.length > 0) {
            warnings.push(
              `${outside.length} file(s) in "${target.name}" live outside ${oldDir} and will not be relocated.`
            )
          }
        } else if (oldDir === null && directory !== null) {
          warnings.push(
            `"${target.name}" was not directory-backed; setting its directory to ${directory} does not move existing files.`
          )
        }
      }

      const modules = graph.modules.map((m) =>
        m.id === op.moduleId
          ? bumpModule(m, { name: op.name, files, symbols, directory })
          : m
      )
      return { ok: true, graph: withModules(graph, modules), warnings }
    }

    case 'update_module': {
      const target = findModule(graph, op.moduleId)
      if (!target) return { ok: false, error: `Module not found: ${op.moduleId}` }
      const patch: Partial<ModuleNode> = {}
      if (op.description !== undefined) patch.description = op.description
      if (op.responsibilities !== undefined) {
        patch.responsibilities = op.responsibilities
      }
      if (op.publicInterface !== undefined) {
        patch.publicInterface = op.publicInterface
      }
      if (op.tags !== undefined) {
        patch.metadata = { ...target.metadata, tags: op.tags }
      }
      const modules = graph.modules.map((m) =>
        m.id === op.moduleId ? bumpModule(m, patch) : m
      )
      return { ok: true, graph: withModules(graph, modules), warnings }
    }

    case 'delete_module': {
      const target = findModule(graph, op.moduleId)
      if (!target) return { ok: false, error: `Module not found: ${op.moduleId}` }

      let modules = graph.modules.filter((m) => m.id !== op.moduleId)
      let unassigned = graph.unassignedFiles

      if (op.fileDisposition === 'reassign') {
        if (!op.reassignTo) {
          return {
            ok: false,
            error: 'delete_module with fileDisposition "reassign" needs reassignTo'
          }
        }
        const dest = findModule(graph, op.reassignTo)
        if (!dest) {
          return { ok: false, error: `Module not found: ${op.reassignTo}` }
        }
        const moved = target.files.map((f) => projectedMoveTarget(f, dest))
        const movedSymbols = target.symbols.map((s) => ({
          ...s,
          file: projectedMoveTarget(s.file, dest)
        }))
        modules = modules.map((m) =>
          m.id === dest.id
            ? bumpModule(m, {
                files: [...new Set([...m.files, ...moved])].sort(),
                symbols: [...m.symbols, ...movedSymbols],
                publicInterface: [
                  ...new Set([...m.publicInterface, ...target.publicInterface])
                ],
                responsibilities: [
                  ...new Set([...m.responsibilities, ...target.responsibilities])
                ]
              })
            : m
        )
      } else if (op.fileDisposition === 'orphan') {
        unassigned = [
          ...new Set([...graph.unassignedFiles, ...target.files])
        ].sort()
        if (target.files.length > 0) {
          warnings.push(
            `${target.files.length} file(s) from "${target.name}" are now unassigned and were left in place.`
          )
        }
      } else if (target.files.length > 0) {
        warnings.push(
          `Deleting "${target.name}" will delete ${target.files.length} source file(s).`
        )
      }

      const edges = graph.edges.filter(
        (e) => e.from !== op.moduleId && e.to !== op.moduleId
      )
      return {
        ok: true,
        graph: {
          ...graph,
          modules,
          edges,
          unassignedFiles: unassigned,
          version: graph.version + 1
        },
        warnings
      }
    }

    case 'move_file': {
      const from = findModule(graph, op.fromModuleId)
      const to = findModule(graph, op.toModuleId)
      if (!from) return { ok: false, error: `Module not found: ${op.fromModuleId}` }
      if (!to) return { ok: false, error: `Module not found: ${op.toModuleId}` }
      if (from.id === to.id) {
        return { ok: false, error: 'Source and target module are the same' }
      }
      const file = normalizeRel(op.file)
      if (!from.files.includes(file)) {
        return {
          ok: false,
          error: `"${file}" does not belong to module "${from.name}"`
        }
      }

      const newPath = projectedMoveTarget(file, to, op.toPath)
      if (newPath === file && to.directory === null) {
        warnings.push(
          `"${to.name}" has no directory, so ${file} changes owner without moving on disk.`
        )
      }

      const movedSymbols = from.symbols.filter((s) => s.file === file)
      const retargeted = movedSymbols.map((s) => ({ ...s, file: newPath }))

      const modules = graph.modules.map((m) => {
        if (m.id === from.id) {
          return bumpModule(m, {
            files: m.files.filter((f) => f !== file),
            symbols: m.symbols.filter((s) => s.file !== file),
            publicInterface: m.publicInterface.filter(
              (name) => !retargeted.some((s) => s.name === name && s.exported)
            )
          })
        }
        if (m.id === to.id) {
          return bumpModule(m, {
            files: [...new Set([...m.files, newPath])].sort(),
            symbols: [...m.symbols, ...retargeted],
            publicInterface: [
              ...new Set([
                ...m.publicInterface,
                ...retargeted.filter((s) => s.exported).map((s) => s.name)
              ])
            ]
          })
        }
        return m
      })
      return { ok: true, graph: withModules(graph, modules), warnings }
    }

    case 'move_symbol': {
      const from = findModule(graph, op.fromModuleId)
      const to = findModule(graph, op.toModuleId)
      if (!from) return { ok: false, error: `Module not found: ${op.fromModuleId}` }
      if (!to) return { ok: false, error: `Module not found: ${op.toModuleId}` }
      const fromFile = normalizeRel(op.fromFile)
      const detailed = op.symbolId ? graph.program.symbols.find((s) => s.id === op.symbolId && s.source.file === fromFile) : undefined
      const symbol = from.symbols.find(
        (s) => s.name === op.symbol && s.file === fromFile
      )
      if (!symbol) {
        warnings.push(
          `Static analysis did not record "${op.symbol}" in ${fromFile}; the move will be attempted anyway.`
        )
      }
      const toFile = op.toFile
        ? normalizeRel(op.toFile)
        : detailed && !['typescript', 'javascript'].includes(detailed.language)
          ? to.files.find((f) => graph.program.symbols.some((s) => s.source.file === f && s.language === detailed.language)) ?? fromFile
        : to.directory
          ? join(to.directory, 'index.ts')
          : fromFile

      const modules = graph.modules.map((m) => {
        if (m.id === from.id) {
          return bumpModule(m, {
            symbols: m.symbols.filter(
              (s) => !(s.name === op.symbol && s.file === fromFile)
            ),
            publicInterface: op.leaveReExport
              ? m.publicInterface
              : m.publicInterface.filter((n) => n !== op.symbol)
          })
        }
        if (m.id === to.id) {
          return bumpModule(m, {
            files: [...new Set([...m.files, toFile])].sort(),
            symbols: symbol
              ? [...m.symbols, { ...symbol, file: toFile }]
              : m.symbols,
            publicInterface: [...new Set([...m.publicInterface, op.symbol])]
          })
        }
        return m
      })
      let next = withModules(graph, modules)
      if (detailed) {
        const targetType = graph.program.symbols.find((s) => s.source.file === toFile && ['class', 'struct', 'interface'].includes(s.kind))
        next = refreshComponents({ ...next, program: { ...next.program, symbols: next.program.symbols.map((s) => {
          if (s.id !== detailed.id) return s
          const scope = detailed.kind === 'method' && targetType ? targetType.qualifiedName : s.scope
          return { ...s, scope, qualifiedName: scope ? `${scope}.${s.name}` : s.name,
            source: { ...s.source, file: toFile }, nameSource: { ...s.nameSource, file: toFile }, signatureSource: { ...s.signatureSource, file: toFile },
            bodySource: s.bodySource ? { ...s.bodySource, file: toFile } : undefined, version: s.version + 1 }
        }) } })
      }
      return { ok: true, graph: next, warnings }
    }

    case 'move_responsibility': {
      const from = findModule(graph, op.fromModuleId)
      const to = findModule(graph, op.toModuleId)
      if (!from) return { ok: false, error: `Module not found: ${op.fromModuleId}` }
      if (!to) return { ok: false, error: `Module not found: ${op.toModuleId}` }
      const modules = graph.modules.map((m) => {
        if (m.id === from.id) {
          return bumpModule(m, {
            responsibilities: m.responsibilities.filter(
              (r) => r !== op.responsibility
            )
          })
        }
        if (m.id === to.id) {
          return bumpModule(m, {
            responsibilities: [
              ...new Set([...m.responsibilities, op.responsibility])
            ]
          })
        }
        return m
      })
      return { ok: true, graph: withModules(graph, modules), warnings }
    }

    case 'add_dependency': {
      if (op.from === op.to) {
        return { ok: false, error: 'A module cannot depend on itself' }
      }
      if (!findModule(graph, op.from)) {
        return { ok: false, error: `Module not found: ${op.from}` }
      }
      if (!findModule(graph, op.to)) {
        return { ok: false, error: `Module not found: ${op.to}` }
      }
      const existing = graph.edges.find(
        (e) => e.from === op.from && e.to === op.to && e.kind === op.kind
      )
      if (existing) {
        if (existing.kind === op.kind) {
          return { ok: false, error: 'That dependency already exists' }
        }
        const edges = graph.edges.map((e) =>
          e === existing ? { ...e, kind: op.kind, version: e.version + 1 } : e
        )
        return {
          ok: true,
          graph: { ...graph, edges, version: graph.version + 1 },
          warnings
        }
      }
      const edge = createEdge({
        from: op.from,
        to: op.to,
        kind: op.kind,
        verified: false,
        confidence: 0.5,
        origin: 'user'
      })
      warnings.push(
        'A declared dependency records intent, not evidence: no import exists for it yet.'
      )
      return {
        ok: true,
        graph: {
          ...graph,
          edges: [...graph.edges, edge],
          version: graph.version + 1
        },
        warnings
      }
    }

    case 'remove_dependency': {
      const existing = graph.edges.find(
        (e) => e.from === op.from && e.to === op.to && (!op.kind || e.kind === op.kind)
      )
      if (!existing) return { ok: false, error: 'That dependency does not exist' }
      if (existing.verified) {
        warnings.push(
          `Removing a verified dependency requires real code changes: ${existing.weight} import(s) still connect these modules.`
        )
      }
      return {
        ok: true,
        graph: {
          ...graph,
          edges: graph.edges.filter((e) => e !== existing),
          version: graph.version + 1
        },
        warnings
      }
    }

    case 'scaffold_module': {
      const target = findModule(graph, op.moduleId)
      if (!target) return { ok: false, error: `Module not found: ${op.moduleId}` }
      // No architectural change: this operation only asks for an implementation.
      return {
        ok: true,
        graph: { ...graph, version: graph.version + 1 },
        warnings
      }
    }

    default: {
      return {
        ok: false,
        error: `Unknown operation: ${JSON.stringify(op)}`
      }
    }
  }
}

/** Folds a log of operations over a graph, collecting warnings and failures. */
export function applyOperations(
  graph: ArchitectureGraph,
  ops: GraphOperation[]
): {
  graph: ArchitectureGraph
  warnings: string[]
  failures: { operationId: string; error: string }[]
} {
  let current = graph
  const warnings: string[] = []
  const failures: { operationId: string; error: string }[] = []
  for (const op of ops) {
    const result = applyOperation(current, op)
    if (result.ok) {
      current = result.graph
      warnings.push(...result.warnings)
    } else {
      failures.push({ operationId: op.id, error: result.error })
    }
  }
  return { graph: current, warnings, failures }
}
