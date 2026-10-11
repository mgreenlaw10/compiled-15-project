/**
 * Prompts for the refactoring agent.
 *
 * Kept in one file, as plain strings, so they are reviewable: the system prompt
 * is the only place where the agent's rules live, and the rules it is given
 * match the honesty guarantees the rest of the application makes.
 *
 * The system prompt is deliberately stable text — no timestamps, no per-request
 * ids — so it caches cleanly across the many turns of one task.
 */

import type { ArchitectureGraph, ModuleNode } from '../../shared/types/architecture'
import type {
  GraphOperation,
  MoveResponsibilityOperation,
  ScaffoldModuleOperation
} from '../../shared/types/operations'
import { findModule } from '../../shared/graph/model'
import { dependenciesOf, dependentsOf } from '../../shared/graph/selectors'

export const SYSTEM_PROMPT = `You are the refactoring agent inside Cartograph, a visual codebase editor.

A developer has edited an architecture graph of their TypeScript/JavaScript project and asked for a change that cannot be made by a mechanical transformation. Your job is to carry out that one change in the project's source code.

How you work:

- Start by orienting yourself with query_graph and read_file. Do not guess at what the code contains.
- Prefer the compiler-aware tools over writing files by hand. move_file_to_module and move_symbol_to_file rewrite every affected import and barrel re-export for you, correctly. Reach for write_file when there is genuinely new code to write, or when a declaration needs editing rather than relocating.
- Preserve existing behaviour. You are refactoring, not redesigning. Keep names, signatures, comments and formatting unless the task requires changing them.
- Match the project's conventions exactly: its quote style, whether relative imports carry file extensions, semicolons, indentation. Read a neighbouring file if you are unsure.
- Make the smallest change that accomplishes the task. Do not reformat files, reorder imports, "improve" unrelated code, or add dependencies.
- Nothing you write reaches the user's disk directly. Your edits build a change set that the developer reviews and approves, so leave the project in a state that compiles rather than a state that is half-migrated.
- Never invent a module, file, symbol or dependency that you have not seen. If something you need does not exist, say so.

How you finish:

Call report_result exactly once, as your last action.

Be accurate about what you achieved. "partial" and "unsupported" are useful, respected answers; a false "applied" is the worst outcome this tool can produce, because the developer will believe their architecture change is done when it is not. If you could not finish, describe precisely what is left and what blocked you, and put anything the developer must check into warnings.`

function moduleSummary(graph: ArchitectureGraph, module: ModuleNode): string {
  const deps = dependenciesOf(graph, module.id)
  const dependents = dependentsOf(graph, module.id)
  return [
    `  id: ${module.id}`,
    `  name: ${module.name}`,
    `  directory: ${module.directory ?? '(none)'}`,
    `  description: ${module.description || '(none)'}`,
    `  responsibilities: ${module.responsibilities.join('; ') || '(none recorded)'}`,
    `  declared public interface: ${module.publicInterface.join(', ') || '(none)'}`,
    `  files: ${module.files.join(', ') || '(none yet)'}`,
    `  depends on: ${deps.map((d) => d.module.id).join(', ') || '(nothing)'}`,
    `  depended on by: ${dependents.map((d) => d.module.id).join(', ') || '(nothing)'}`
  ].join('\n')
}

function projectContext(graph: ArchitectureGraph): string {
  return [
    `Project: ${graph.name}`,
    `Modules (${graph.modules.length}):`,
    ...graph.modules.map(
      (m) =>
        `  ${m.id} — "${m.name}"${m.directory ? ` (${m.directory})` : ''} — ${m.files.length} file(s)`
    ),
    '',
    'Import conventions matter in this project. Check an existing file before writing new imports.'
  ].join('\n')
}

export function moveResponsibilityPrompt(
  op: MoveResponsibilityOperation & GraphOperation,
  graph: ArchitectureGraph
): string {
  const from = findModule(graph, op.fromModuleId)
  const to = findModule(graph, op.toModuleId)
  return [
    projectContext(graph),
    '',
    'Task: move a responsibility between modules.',
    '',
    `Responsibility: "${op.responsibility}"`,
    '',
    `Move it OUT OF this module:`,
    from ? moduleSummary(graph, from) : `  (missing module ${op.fromModuleId})`,
    '',
    `and INTO this module:`,
    to ? moduleSummary(graph, to) : `  (missing module ${op.toModuleId})`,
    '',
    'Work out which declarations in the source module actually implement that responsibility — read them before deciding. Relocate those declarations into the target module with move_symbol_to_file, or move whole files with move_file_to_module when the file is entirely about this responsibility. Leave everything else where it is.',
    '',
    'If the responsibility does not correspond to identifiable code, do not invent an implementation: report "unsupported" and explain what you looked for.'
  ].join('\n')
}

export function scaffoldModulePrompt(
  op: ScaffoldModuleOperation & GraphOperation,
  graph: ArchitectureGraph
): string {
  const target = findModule(graph, op.moduleId)
  return [
    projectContext(graph),
    '',
    'Task: write the implementation for a module the developer created in the graph.',
    '',
    'Target module:',
    target ? moduleSummary(graph, target) : `  (missing module ${op.moduleId})`,
    '',
    op.instructions.trim() !== ''
      ? `Additional instructions from the developer:\n${op.instructions.trim()}`
      : 'The developer gave no extra instructions beyond the module description above.',
    '',
    'Write real, working code for the declared responsibilities and public interface. Use the types, data-access helpers and utilities this project already has rather than introducing new dependencies — look them up first. Replace any placeholder that throws "not implemented".',
    '',
    'If the module already contains a real implementation, do not rewrite it; report what you found instead.'
  ].join('\n')
}
