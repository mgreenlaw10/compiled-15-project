/**
 * The briefing an agent gets before it touches anything.
 *
 * Built from the architecture graph the analyzer already produces, so the agent
 * starts with what the project knows about itself rather than rediscovering it
 * by reading every file. That is the whole point of having the graph: it is the
 * shared architectural specification, and the agent is one more reader of it.
 *
 * Deliberately included: the module's own interface and contracts, the
 * interfaces of modules it depends on, who depends on *it* (so it knows what it
 * must not break), the files it may write, and what other agents are doing
 * right now. Deliberately excluded: anything secret, and anything about where
 * other people's worktrees live.
 */

import type {
  ArchitectureGraph,
  ModuleId,
  ModuleNode
} from '../../shared/types/architecture'
import type { ProgramSymbol } from '../../shared/types/program'
import type { ProjectState, Task } from '../../shared/collab'
import { isActiveTask } from '../../shared/collab'
import { dependenciesOf, dependentsOf } from '../../shared/graph/selectors'

/** How much of a symbol's source to quote. Enough to judge, not a whole file. */
const MAX_SOURCE_EXCERPT = 1200
const MAX_SYMBOLS_PER_SECTION = 14

function symbolLine(symbol: ProgramSymbol): string {
  const signature =
    symbol.signature.trim() !== ''
      ? symbol.signature.trim()
      : `${symbol.name}(${symbol.parameters
          .map((p) => `${p.name}: ${p.type}`)
          .join(', ')}): ${symbol.returnType}`
  return `  - ${signature}${symbol.description ? `  // ${symbol.description}` : ''}`
}

function symbolsByIds(
  graph: ArchitectureGraph,
  ids: readonly string[]
): ProgramSymbol[] {
  const byId = new Map(graph.program.symbols.map((s) => [s.id, s]))
  return ids
    .map((id) => byId.get(id))
    .filter((s): s is ProgramSymbol => s !== undefined)
}

function describeModuleInterface(
  graph: ArchitectureGraph,
  module: ModuleNode
): string[] {
  const lines: string[] = []
  const fns = symbolsByIds(graph, module.components.interface.functionIds).slice(
    0,
    MAX_SYMBOLS_PER_SECTION
  )
  const types = symbolsByIds(graph, module.components.interface.typeIds).slice(
    0,
    MAX_SYMBOLS_PER_SECTION
  )

  if (fns.length > 0) {
    lines.push('Public functions:')
    lines.push(...fns.map(symbolLine))
  }
  if (types.length > 0) {
    lines.push('Public types:')
    lines.push(...types.map(symbolLine))
  }
  if (lines.length === 0 && module.publicInterface.length > 0) {
    lines.push(`Exports: ${module.publicInterface.join(', ')}`)
  }
  return lines
}

export interface AgentBriefOptions {
  graph: ArchitectureGraph
  task: Task
  /** Shared state, for "what else is happening". `null` when running solo. */
  collabState?: ProjectState | null
  /** Files the task is allowed to write, for the scope section. */
  allowedPaths: { moduleId: ModuleId; directory: string | null; files: string[] }[]
  /** Commit the task branched from. */
  baseCommit: string | null
}

/**
 * The task brief, as one prompt-ready string.
 *
 * Written as plain prose and lists rather than JSON: it is read by a model, and
 * the structure that matters is the headings.
 */
export function buildAgentBrief(options: AgentBriefOptions): string {
  const { graph, task } = options
  const sections: string[] = []

  sections.push(
    `# Task: ${task.title}`,
    '',
    task.description || '(no further description was given)',
    ''
  )

  const modules = task.moduleIds
    .map((id) => graph.modules.find((m) => m.id === id))
    .filter((m): m is ModuleNode => m !== undefined)

  // --- the modules this task owns -----------------------------------------
  for (const module of modules) {
    sections.push(`## Your module: ${module.name} (${module.id})`, '')
    if (module.description) sections.push(module.description, '')
    if (module.responsibilities.length > 0) {
      sections.push('Responsibilities:')
      sections.push(...module.responsibilities.map((r) => `  - ${r}`))
      sections.push('')
    }
    if (module.directory) sections.push(`Directory: ${module.directory}`)
    if (module.files.length > 0) {
      sections.push(
        `Files (${module.files.length}): ${module.files.slice(0, 25).join(', ')}${
          module.files.length > 25 ? ', …' : ''
        }`
      )
    }
    sections.push('')

    const iface = describeModuleInterface(graph, module)
    if (iface.length > 0) {
      sections.push('### Public interface (other modules depend on this)', ...iface, '')
    }

    const dataStructures = symbolsByIds(
      graph,
      module.components.dataStructures.symbolIds
    ).slice(0, MAX_SYMBOLS_PER_SECTION)
    if (dataStructures.length > 0) {
      sections.push('### Data structures')
      for (const symbol of dataStructures) {
        sections.push(
          `  - ${symbol.name}: ${symbol.fields.map((f) => `${f.name}: ${f.type}`).join('; ') || symbol.signature}`
        )
      }
      sections.push('')
    }

    const contracts = graph.program.contracts.filter((c) =>
      module.components.contracts.contractIds.includes(c.id)
    )
    if (contracts.length > 0) {
      sections.push('### Behavioural contracts you must preserve')
      for (const contract of contracts.slice(0, MAX_SYMBOLS_PER_SECTION)) {
        sections.push(
          `  - [${contract.category}] ${contract.description} (${contract.verification})`
        )
      }
      sections.push('')
    }

    // A little real source, so the agent sees the house style before writing.
    const implementation = symbolsByIds(
      graph,
      module.components.implementation.symbolIds
    ).slice(0, 4)
    if (implementation.length > 0) {
      sections.push('### Existing implementation (excerpts)', '```')
      for (const symbol of implementation) {
        sections.push(symbol.sourceText.slice(0, MAX_SOURCE_EXCERPT))
        sections.push('')
      }
      sections.push('```', '')
    }
  }

  // --- neighbours ----------------------------------------------------------
  const dependencyIds = new Set<ModuleId>()
  const dependentIds = new Set<ModuleId>()
  for (const module of modules) {
    for (const dep of dependenciesOf(graph, module.id)) dependencyIds.add(dep.module.id)
    for (const dep of dependentsOf(graph, module.id)) dependentIds.add(dep.module.id)
  }
  for (const id of task.moduleIds) {
    dependencyIds.delete(id)
    dependentIds.delete(id)
  }

  if (dependencyIds.size > 0) {
    sections.push('## Modules you depend on', '')
    sections.push(
      'You may read these, and you may call their public interfaces. Do not modify them.',
      ''
    )
    for (const id of [...dependencyIds].slice(0, 6)) {
      const module = graph.modules.find((m) => m.id === id)
      if (!module) continue
      sections.push(`### ${module.name} (${module.id})`)
      if (module.description) sections.push(module.description)
      sections.push(...describeModuleInterface(graph, module), '')
    }
  }

  if (dependentIds.size > 0) {
    const names = [...dependentIds]
      .map((id) => graph.modules.find((m) => m.id === id)?.name ?? id)
      .join(', ')
    sections.push(
      '## Modules that depend on you',
      '',
      `${names} use your public interface. Changing a public signature, removing an export, or altering a data structure will affect them — the integration step will detect it and flag the incompatibility. If the task genuinely requires such a change, make it and say so clearly in your final report.`,
      ''
    )
  }

  // --- scope ---------------------------------------------------------------
  sections.push('## What you may change', '')
  for (const scope of options.allowedPaths) {
    const where = scope.directory
      ? `anything under ${scope.directory}/`
      : `these files: ${scope.files.slice(0, 20).join(', ')}`
    sections.push(`  - ${scope.moduleId}: ${where}`)
  }
  sections.push(
    '',
    'You may read any file in the project to understand it. You may only *write* inside the modules listed above. Changes outside them are detected when the task is submitted and will be reported for a human to review, so do not make them casually — if you genuinely need one, use report_result to explain why.',
    ''
  )

  // --- concurrent work -----------------------------------------------------
  const otherTasks = (options.collabState?.tasks ?? []).filter(
    (other) => other.id !== task.id && isActiveTask(other.status)
  )
  if (otherTasks.length > 0) {
    sections.push('## Work happening at the same time', '')
    for (const other of otherTasks.slice(0, 8)) {
      const where = other.moduleIds
        .map((id) => graph.modules.find((m) => m.id === id)?.name ?? id)
        .join(', ')
      sections.push(
        `  - "${other.title}" (${other.status}) in ${where}${
          other.assignedAgent ? `, by ${other.assignedAgent}` : ''
        }`
      )
    }
    const overlapping = otherTasks.filter((other) =>
      other.moduleIds.some((id) => dependencyIds.has(id) || dependentIds.has(id))
    )
    if (overlapping.length > 0) {
      sections.push(
        '',
        'Some of that work is in modules related to yours. Their changes are not visible to you — you are working from a snapshot — so prefer additive changes to shared interfaces over breaking ones where the task allows it.'
      )
    }
    sections.push('')
  }

  if (options.baseCommit) {
    sections.push(
      `## Starting point`,
      '',
      `Your branch was forked from ${options.baseCommit.slice(0, 8)} on the integrated branch. Anything merged after that is not in your working copy.`,
      ''
    )
  }

  sections.push(
    '## When you are done',
    '',
    'Call report_result with an honest status. If you could not finish, say what is missing. If you changed a public interface, say which one and what depends on it. A partial change described accurately is far more useful than a complete-sounding summary that is not true.'
  )

  return sections.join('\n')
}

/** A one-line summary of the brief, for the activity log. */
export function summarizeBrief(task: Task, graph: ArchitectureGraph): string {
  const names = task.moduleIds
    .map((id) => graph.modules.find((m) => m.id === id)?.name ?? id)
    .join(', ')
  return `${task.title} — ${names}`
}
