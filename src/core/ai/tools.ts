/**
 * The tools the AI agent is given.
 *
 * Two principles shape this surface:
 *
 *  1. **The model cannot touch the disk.** Every write goes into the virtual
 *     workspace, which the user still has to review and approve. The worst a
 *     confused model can do is produce a change set that gets rejected.
 *  2. **The model should reuse the deterministic machinery, not re-implement
 *     it.** Moving a file and moving a symbol are exposed as *tools*, so the
 *     agent asks for a compiler-aware refactor instead of hand-editing import
 *     statements. Hand-written file contents are a fallback, not the default.
 *
 * Every path an argument carries is validated against the project before use,
 * and each tool input is re-validated against its schema after parsing, because
 * eager input streaming means the server no longer does that for us.
 */

import { z } from 'zod'
import type { ChatTool } from './providers/chat'

import type { ArchitectureGraph } from '../../shared/types/architecture'
import type { GraphOperation } from '../../shared/types/operations'
import {
  dependenciesOf,
  dependentsOf,
  importantSymbols
} from '../../shared/graph/selectors'
import { findModule } from '../../shared/graph/model'
import { normalizeRel } from '../../shared/util/paths'
import { executeMoveFile } from '../transform/ops/module-ops'
import { executeMoveSymbol } from '../transform/ops/move-symbol'
import type { OpContext } from '../transform/ops/context'
import type { VirtualWorkspace } from '../transform/workspace'
import type { ChannelLogger } from '../logger'

const MAX_FILE_CHARS = 40_000
const MAX_LIST = 300

// ---------------------------------------------------------------------------
// Schemas. `z.toJSONSchema` derives the wire schema from these, so the shape
// the model is told about and the shape we validate against cannot drift.
// ---------------------------------------------------------------------------

const QueryGraphInput = z
  .object({
    what: z
      .enum(['modules', 'module', 'dependencies', 'dependents', 'edge_evidence'])
      .describe(
        'modules: every module with its files. module: one module in full. dependencies/dependents: a module\'s neighbours. edge_evidence: the concrete imports behind one edge.'
      ),
    moduleId: z.string().optional().describe('Required for everything but "modules".'),
    otherModuleId: z
      .string()
      .optional()
      .describe('The other end of the edge, for "edge_evidence".')
  })
  .strict()

const ListFilesInput = z
  .object({
    moduleId: z.string().optional().describe('Only files belonging to this module.'),
    prefix: z
      .string()
      .optional()
      .describe('Only files whose project-relative path starts with this.')
  })
  .strict()

const ReadFileInput = z
  .object({
    path: z.string().describe('Project-relative path, e.g. src/auth/session.ts'),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional()
  })
  .strict()

const FindSymbolInput = z
  .object({
    name: z.string().describe('Exact or partial symbol name, case-insensitive.')
  })
  .strict()

const WriteFileInput = z
  .object({
    path: z.string().describe('Project-relative path. Parent directories are created.'),
    contents: z.string().describe('The complete new contents of the file.'),
    reason: z.string().describe('One line explaining the change, shown to the user.')
  })
  .strict()

const DeleteFileInput = z
  .object({
    path: z.string(),
    reason: z.string()
  })
  .strict()

const MoveFileInput = z
  .object({
    file: z.string().describe('Project-relative path of the file to move.'),
    toModuleId: z.string().describe('Module id to move it into.'),
    toPath: z
      .string()
      .optional()
      .describe('Explicit destination path; defaults to the module directory.')
  })
  .strict()

const MoveSymbolInput = z
  .object({
    symbol: z.string().describe('Name of a top-level declaration.'),
    fromFile: z.string().describe('File that currently declares it.'),
    toModuleId: z.string().describe('Module id that should own it.'),
    toFile: z
      .string()
      .optional()
      .describe('Destination file; defaults to the target module\'s index.ts.'),
    leaveReExport: z
      .boolean()
      .default(false)
      .describe('Leave a re-export behind so existing importers keep working.')
  })
  .strict()

const ReportResultInput = z
  .object({
    status: z
      .enum(['applied', 'partial', 'unsupported'])
      .describe(
        'applied: the operation is fully carried out. partial: some of it, with the rest described. unsupported: you could not do it — say why.'
      ),
    summary: z.string().describe('What you changed, in one or two sentences.'),
    warnings: z
      .array(z.string())
      .default([])
      .describe('Anything the user must check by hand.')
  })
  .strict()

const SCHEMAS = {
  query_graph: QueryGraphInput,
  list_files: ListFilesInput,
  read_file: ReadFileInput,
  find_symbol: FindSymbolInput,
  write_file: WriteFileInput,
  delete_file: DeleteFileInput,
  move_file_to_module: MoveFileInput,
  move_symbol_to_file: MoveSymbolInput,
  report_result: ReportResultInput
} as const

export type ToolName = keyof typeof SCHEMAS

const DESCRIPTIONS: Record<ToolName, string> = {
  query_graph:
    'Inspect the architecture graph: modules, their files and responsibilities, their dependencies, and the real import statements behind any edge. Start here.',
  list_files:
    'List the project\'s source files, optionally narrowed to one module or a path prefix.',
  read_file:
    'Read a source file as it currently stands, including edits you have already made in this task.',
  find_symbol:
    'Find where a class, function, interface or constant is declared, and which module owns it.',
  write_file:
    'Create or replace a file. Use this for new code. Prefer move_file_to_module or move_symbol_to_file when relocating existing code, because those rewrite imports for you.',
  delete_file: 'Delete a file. Check first that nothing still imports it.',
  move_file_to_module:
    'Move a file into another module. Rewrites the file\'s own imports and every import of it across the project. Compiler-aware and reliable — prefer it over rewriting imports by hand.',
  move_symbol_to_file:
    'Move one top-level declaration into another file, carrying the imports it needs, exporting anything it depends on, and updating every importer and barrel re-export. Compiler-aware.',
  report_result:
    'Finish the task. Call this exactly once, at the end, and be honest about what you did not manage to do.'
}

/**
 * The tool definitions sent with every request.
 *
 * Provider-neutral: each provider translates these into its own wire format,
 * and whether inputs stream eagerly is the provider's concern. Inputs are
 * re-validated in `runTool` regardless of what the server did or did not check.
 */
export function toolDefinitions(): ChatTool[] {
  return (Object.keys(SCHEMAS) as ToolName[]).map((name) => {
    const schema = z.toJSONSchema(SCHEMAS[name], { target: 'draft-7' }) as Record<
      string,
      unknown
    >
    delete schema.$schema
    return {
      name,
      description: DESCRIPTIONS[name],
      inputSchema: schema
    }
  })
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ToolRunContext {
  workspace: VirtualWorkspace
  graph: ArchitectureGraph
  nextGraph: ArchitectureGraph
  /** The operation being carried out, used to attribute file changes. */
  operation: GraphOperation
  log: ChannelLogger
  maxFileReads: number
}

export interface ToolRunState {
  fileReads: number
  touchedPaths: Set<string>
  finalReport: z.infer<typeof ReportResultInput> | null
}

export function createToolRunState(): ToolRunState {
  return { fileReads: 0, touchedPaths: new Set(), finalReport: null }
}

export interface ToolOutcome {
  content: string
  isError: boolean
}

function err(message: string): ToolOutcome {
  return { content: `ERROR: ${message}`, isError: true }
}

function okText(message: string): ToolOutcome {
  return { content: message, isError: false }
}

/**
 * Validates a model-supplied path.
 *
 * Schema validation is not path validation: the model's output is untrusted, so
 * anything that is absolute, escapes the project, or reaches into a dependency
 * directory is refused outright rather than normalised into something plausible.
 */
export function validateProjectPath(raw: string): { path: string } | { error: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { error: 'The path is empty.' }
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return { error: `"${raw}" is absolute. Use a project-relative path.` }
  }
  if (trimmed.split(/[\\/]/).includes('..')) {
    return { error: `"${raw}" tries to leave the project directory.` }
  }
  const normalized = normalizeRel(trimmed)
  if (normalized === '') return { error: `"${raw}" does not name a file.` }
  if (normalized.split('/').some((segment) => segment === 'node_modules' || segment === '.git')) {
    return { error: `"${raw}" is inside a directory Cartograph will not modify.` }
  }
  return { path: normalized }
}

function describeModule(graph: ArchitectureGraph, id: string): string {
  const m = findModule(graph, id)
  if (!m) return `No module with id "${id}".`
  const lines = [
    `module ${m.id}`,
    `  name: ${m.name}`,
    `  directory: ${m.directory ?? '(none — not directory-backed)'}`,
    `  description: ${m.description}`,
    `  responsibilities: ${m.responsibilities.join('; ') || '(none recorded)'}`,
    `  confidence: ${m.metadata.confidence} (${m.metadata.confidenceBasis})`,
    `  files (${m.files.length}):`,
    ...m.files.map((f) => `    ${f}`),
    `  exported symbols: ${m.publicInterface.join(', ') || '(none)'}`,
    `  notable declarations:`,
    ...importantSymbols(m).map(
      (s) => `    ${s.exported ? 'export ' : ''}${s.kind} ${s.name} — ${s.file}:${s.line}`
    )
  ]
  return lines.join('\n')
}

export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: ToolRunContext,
  state: ToolRunState
): Promise<ToolOutcome> {
  if (!(name in SCHEMAS)) return err(`There is no tool called "${name}".`)
  const toolName = name as ToolName

  const parsed = SCHEMAS[toolName].safeParse(rawInput)
  if (!parsed.success) {
    return err(
      `The arguments did not match the schema for ${toolName}: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`
    )
  }

  switch (toolName) {
    case 'query_graph': {
      const input = parsed.data as z.infer<typeof QueryGraphInput>
      if (input.what === 'modules') {
        return okText(
          ctx.nextGraph.modules
            .map(
              (m) =>
                `${m.id} — "${m.name}" — ${m.files.length} file(s)${
                  m.directory ? ` in ${m.directory}` : ' (no directory)'
                }: ${m.description}`
            )
            .join('\n')
        )
      }
      if (!input.moduleId) return err(`"${input.what}" needs a moduleId.`)
      if (input.what === 'module') {
        return okText(describeModule(ctx.nextGraph, input.moduleId))
      }
      if (input.what === 'dependencies' || input.what === 'dependents') {
        const neighbours =
          input.what === 'dependencies'
            ? dependenciesOf(ctx.nextGraph, input.moduleId)
            : dependentsOf(ctx.nextGraph, input.moduleId)
        if (neighbours.length === 0) return okText('(none)')
        return okText(
          neighbours
            .map(
              ({ edge, module }) =>
                `${module.id} ("${module.name}") — ${edge.kind}, ${edge.weight} import(s), ${
                  edge.verified ? 'verified by static analysis' : 'declared by a user, NOT backed by imports'
                }`
            )
            .join('\n')
        )
      }
      // edge_evidence
      if (!input.otherModuleId) return err('"edge_evidence" needs otherModuleId.')
      const edge = ctx.nextGraph.edges.find(
        (e) => e.from === input.moduleId && e.to === input.otherModuleId
      )
      if (!edge) return okText('There is no such edge in the graph.')
      return okText(
        [
          `${edge.from} -> ${edge.to} (${edge.kind}), weight ${edge.weight}, verified: ${edge.verified}`,
          ...edge.evidence.map(
            (e) =>
              `  ${e.fromFile}:${e.line} imports ${e.symbols.join(', ')} from "${e.specifier}" (${e.toFile})`
          )
        ].join('\n')
      )
    }

    case 'list_files': {
      const input = parsed.data as z.infer<typeof ListFilesInput>
      let files = ctx.workspace.listFiles()
      if (input.moduleId) {
        const m = findModule(ctx.nextGraph, input.moduleId)
        if (!m) return err(`No module with id "${input.moduleId}".`)
        const owned = new Set(
          m.files.map((f) => ctx.workspace.currentPathOf(f) ?? f)
        )
        files = files.filter((f) => owned.has(f))
      }
      if (input.prefix) {
        const prefix = normalizeRel(input.prefix)
        files = files.filter((f) => f.startsWith(prefix))
      }
      if (files.length === 0) return okText('(no matching files)')
      const shown = files.slice(0, MAX_LIST)
      return okText(
        shown.join('\n') +
          (files.length > shown.length
            ? `\n… and ${files.length - shown.length} more`
            : '')
      )
    }

    case 'read_file': {
      const input = parsed.data as z.infer<typeof ReadFileInput>
      if (state.fileReads >= ctx.maxFileReads) {
        return err(
          `You have reached this task's limit of ${ctx.maxFileReads} file reads. Work with what you have, or call report_result.`
        )
      }
      const checked = validateProjectPath(input.path)
      if ('error' in checked) return err(checked.error)
      const content = ctx.workspace.read(checked.path)
      if (content === null) {
        return err(
          `${checked.path} is not one of this project's analyzed source files. Use list_files to see what is available.`
        )
      }
      state.fileReads += 1
      ctx.log.debug(`AI read ${checked.path}`)

      const lines = content.split('\n')
      const start = Math.max(1, input.startLine ?? 1)
      const end = Math.min(lines.length, input.endLine ?? lines.length)
      const slice = lines.slice(start - 1, end).join('\n')
      const body =
        slice.length > MAX_FILE_CHARS
          ? `${slice.slice(0, MAX_FILE_CHARS)}\n… truncated; request a line range …`
          : slice
      return okText(`${checked.path} (lines ${start}-${end} of ${lines.length}):\n${body}`)
    }

    case 'find_symbol': {
      const input = parsed.data as z.infer<typeof FindSymbolInput>
      const needle = input.name.toLowerCase()
      const hits = ctx.nextGraph.modules.flatMap((m) =>
        m.symbols
          .filter((s) => s.name.toLowerCase().includes(needle))
          .map(
            (s) =>
              `${s.name} — ${s.kind}${s.exported ? ', exported' : ''} — ${s.file}:${s.line} — module ${m.id} ("${m.name}")`
          )
      )
      return okText(hits.length > 0 ? hits.slice(0, 50).join('\n') : '(no matches)')
    }

    case 'write_file': {
      const input = parsed.data as z.infer<typeof WriteFileInput>
      const checked = validateProjectPath(input.path)
      if ('error' in checked) return err(checked.error)
      const existed = ctx.workspace.exists(checked.path)
      ctx.workspace.write(checked.path, input.contents, {
        reason: `AI: ${input.reason}`,
        operationId: ctx.operation.id
      })
      state.touchedPaths.add(checked.path)
      ctx.log.info(
        `AI ${existed ? 'rewrote' : 'created'} ${checked.path}`,
        input.reason
      )
      return okText(
        `${existed ? 'Replaced' : 'Created'} ${checked.path} (${input.contents.split('\n').length} lines). Nothing has been written to disk; the user will review this change.`
      )
    }

    case 'delete_file': {
      const input = parsed.data as z.infer<typeof DeleteFileInput>
      const checked = validateProjectPath(input.path)
      if ('error' in checked) return err(checked.error)
      const removed = ctx.workspace.delete(checked.path, {
        reason: `AI: ${input.reason}`,
        operationId: ctx.operation.id
      })
      if (!removed) return err(`${checked.path} does not exist.`)
      state.touchedPaths.add(checked.path)
      ctx.log.warn(`AI deleted ${checked.path}`, input.reason)
      return okText(`Deleted ${checked.path}.`)
    }

    case 'move_file_to_module': {
      const input = parsed.data as z.infer<typeof MoveFileInput>
      const checked = validateProjectPath(input.file)
      if ('error' in checked) return err(checked.error)
      const owner = ctx.nextGraph.modules.find((m) =>
        m.files.some((f) => (ctx.workspace.currentPathOf(f) ?? f) === checked.path)
      )
      if (!owner) {
        return err(
          `${checked.path} is not attributed to any module, so there is nothing to move it out of.`
        )
      }
      const opCtx: OpContext = {
        workspace: ctx.workspace,
        graph: ctx.nextGraph,
        nextGraph: ctx.nextGraph,
        log: ctx.log
      }
      const result = executeMoveFile(
        {
          ...ctx.operation,
          type: 'move_file',
          file: checked.path,
          fromModuleId: owner.id,
          toModuleId: input.toModuleId,
          ...(input.toPath ? { toPath: input.toPath } : {})
        } as Parameters<typeof executeMoveFile>[0],
        opCtx
      )
      for (const p of result.touchedPaths) state.touchedPaths.add(p)
      return result.status === 'failed'
        ? err(result.message)
        : okText(
            [result.message, ...result.warnings.map((w) => `warning: ${w}`)].join('\n')
          )
    }

    case 'move_symbol_to_file': {
      const input = parsed.data as z.infer<typeof MoveSymbolInput>
      const fromChecked = validateProjectPath(input.fromFile)
      if ('error' in fromChecked) return err(fromChecked.error)
      let toFile: string | undefined
      if (input.toFile) {
        const toChecked = validateProjectPath(input.toFile)
        if ('error' in toChecked) return err(toChecked.error)
        toFile = toChecked.path
      }
      const owner = ctx.nextGraph.modules.find((m) =>
        m.files.some((f) => (ctx.workspace.currentPathOf(f) ?? f) === fromChecked.path)
      )
      const opCtx: OpContext = {
        workspace: ctx.workspace,
        graph: ctx.nextGraph,
        nextGraph: ctx.nextGraph,
        log: ctx.log
      }
      const result = executeMoveSymbol(
        {
          ...ctx.operation,
          type: 'move_symbol',
          symbol: input.symbol,
          fromFile: fromChecked.path,
          fromModuleId: owner?.id ?? '',
          toModuleId: input.toModuleId,
          ...(toFile ? { toFile } : {}),
          leaveReExport: input.leaveReExport
        } as Parameters<typeof executeMoveSymbol>[0],
        opCtx
      )
      for (const p of result.touchedPaths) state.touchedPaths.add(p)
      return result.status === 'failed'
        ? err(result.message)
        : okText(
            [result.message, ...result.warnings.map((w) => `warning: ${w}`)].join('\n')
          )
    }

    case 'report_result': {
      state.finalReport = parsed.data as z.infer<typeof ReportResultInput>
      return okText('Recorded. The task is finished.')
    }

    default: {
      const exhaustive: never = toolName
      return err(`Unhandled tool ${String(exhaustive)}`)
    }
  }
}
