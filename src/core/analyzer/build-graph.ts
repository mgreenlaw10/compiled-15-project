/**
 * Assembling the architecture graph.
 *
 * Takes the per-file facts from the language analyzers plus the module
 * boundaries from the clusterer, and produces the `ArchitectureGraph` the rest
 * of the application works with.
 *
 * The only edges created here are backed by real imports, and each one carries
 * the concrete import statements that justify it (`DependencyEvidence`). That
 * is what lets the inspector answer "why does the graph say A depends on B?"
 * with file names and line numbers instead of an assertion.
 */

import type {
  AnalysisSummary,
  AnalysisWarning,
  ArchitectureGraph,
  DependencyEdge,
  DependencyEvidence,
  ModuleNode
} from '../../shared/types/architecture'
import { createGraph, createModule } from '../../shared/graph/model'
import { edgeId } from '../../shared/util/id'
import type { ModuleDraft } from './cluster'
import type { FileAnalysis } from './languages'
import { normalizeResponsibilities, responsibilityFromSymbol, roleOf } from './lexicon'

export const ANALYZER_VERSION = '1.0.0'

/** Caps how many symbols a module carries, to keep saved documents sane. */
const MAX_SYMBOLS_PER_MODULE = 60
const MAX_EVIDENCE_PER_EDGE = 25

export interface BuildGraphInput {
  projectRoot: string
  projectName: string
  analyses: FileAnalysis[]
  drafts: ModuleDraft[]
  unassignedFiles: string[]
  sourceRoots: string[]
  fileCount: number
  skippedFileCount: number
  loc: number
  languages: Record<string, number>
  durationMs: number
  warnings?: AnalysisWarning[]
}

function describeModule(
  draft: ModuleDraft,
  exportedNames: string[],
  fileCount: number
): string {
  const role = draft.tags.length > 0 ? roleOf(draft.tags[0]) : ''
  const where = draft.directory
    ? `${fileCount} file${fileCount === 1 ? '' : 's'} under ${draft.directory}`
    : `${fileCount} file${fileCount === 1 ? '' : 's'} grouped by naming`
  const exports =
    exportedNames.length > 0
      ? `, exporting ${exportedNames.slice(0, 4).join(', ')}${
          exportedNames.length > 4 ? `, +${exportedNames.length - 4} more` : ''
        }`
      : ', with no exported symbols'
  return `${role ? `${role} ` : ''}${where}${exports}.`.trim()
}

export function buildGraph(input: BuildGraphInput): ArchitectureGraph {
  const analysisByPath = new Map(input.analyses.map((a) => [a.path, a]))
  const moduleOfFile = new Map<string, string>()
  for (const draft of input.drafts) {
    for (const file of draft.files) moduleOfFile.set(file, draft.id)
  }

  // ---- Modules -----------------------------------------------------------
  const modules: ModuleNode[] = input.drafts.map((draft) => {
    const fileAnalyses = draft.files
      .map((f) => analysisByPath.get(f))
      .filter((a): a is FileAnalysis => a !== undefined)

    const symbols = fileAnalyses
      .flatMap((a) => a.symbols)
      .sort((a, b) => {
        if (a.exported !== b.exported) return a.exported ? -1 : 1
        if (a.loc !== b.loc) return b.loc - a.loc
        return a.name.localeCompare(b.name)
      })
      .slice(0, MAX_SYMBOLS_PER_MODULE)

    const exportedNames = [
      ...new Set(fileAnalyses.flatMap((a) => a.exportedNames))
    ]
      .map((n) => n.replace(/^default:/, ''))
      .filter((n) => !n.startsWith('*:'))
      .sort()

    const externalDependencies = [
      ...new Set(
        fileAnalyses
          .flatMap((a) => a.imports)
          .filter((i) => i.external && i.packageName)
          .map((i) => i.packageName as string)
      )
    ].sort()

    const responsibilities = normalizeResponsibilities(
      symbols
        .filter((s) => s.exported)
        .map((s) => responsibilityFromSymbol(s.name))
    )

    const loc = fileAnalyses.reduce((sum, a) => sum + a.loc, 0)

    const node = createModule({
      id: draft.id,
      name: draft.name,
      description: describeModule(draft, exportedNames, draft.files.length),
      responsibilities,
      files: draft.files,
      directory: draft.directory,
      publicInterface: exportedNames,
      externalDependencies,
      origin: 'analysis',
      confidence: draft.confidence,
      confidenceBasis: 'heuristic',
      notes: [...draft.notes],
      loc,
      tags: draft.tags
    })
    node.symbols = symbols
    return node
  })

  const moduleById = new Map(modules.map((m) => [m.id, m]))

  // ---- Edges -------------------------------------------------------------
  const edgeMap = new Map<string, DependencyEdge>()
  // Per module: imports that stay inside it vs. imports that leave it. Used
  // below to turn cohesion into a confidence adjustment the user can read.
  const internalImportCount = new Map<string, number>()
  const outgoingImportCount = new Map<string, number>()

  for (const analysis of input.analyses) {
    const fromModule = moduleOfFile.get(analysis.path)
    if (!fromModule) continue

    for (const imp of analysis.imports) {
      if (imp.external || imp.resolvedPath === null) continue
      const toModule = moduleOfFile.get(imp.resolvedPath)
      if (!toModule) continue

      if (toModule === fromModule) {
        internalImportCount.set(
          fromModule,
          (internalImportCount.get(fromModule) ?? 0) + 1
        )
        continue
      }
      outgoingImportCount.set(
        fromModule,
        (outgoingImportCount.get(fromModule) ?? 0) + 1
      )

      const id = edgeId(fromModule, toModule, 'imports')
      const evidence: DependencyEvidence = {
        fromFile: analysis.path,
        toFile: imp.resolvedPath,
        specifier: imp.specifier,
        symbols: imp.symbols.length > 0 ? imp.symbols : ['*'],
        line: imp.line
      }

      const existing = edgeMap.get(id)
      if (existing) {
        existing.weight += 1
        if (existing.evidence.length < MAX_EVIDENCE_PER_EDGE) {
          existing.evidence.push(evidence)
        }
      } else {
        edgeMap.set(id, {
          id,
          from: fromModule,
          to: toModule,
          kind: 'imports',
          weight: 1,
          verified: true,
          confidence: 1,
          evidence: [evidence],
          origin: 'static',
          version: 1
        })
      }
    }
  }

  // ---- Confidence adjustment from cohesion -------------------------------
  for (const m of modules) {
    const internal = internalImportCount.get(m.id) ?? 0
    const outgoing = outgoingImportCount.get(m.id) ?? 0
    const total = internal + outgoing
    if (total === 0) {
      m.metadata.notes.push(
        'Nothing in this module imports anything else in the project; it is a leaf.'
      )
      continue
    }
    const cohesion = internal / total
    m.metadata.notes.push(
      `${Math.round(cohesion * 100)}% of the imports written in this module point at files inside it (${internal} of ${total}).`
    )
    let adjusted = m.metadata.confidence
    if (cohesion >= 0.7) adjusted += 0.1
    else if (cohesion < 0.3 && total >= 4) adjusted -= 0.15
    m.metadata.confidence = Math.min(0.95, Math.max(0.2, Number(adjusted.toFixed(2))))
  }

  const warnings: AnalysisWarning[] = [...(input.warnings ?? [])]
  for (const analysis of input.analyses) {
    for (const problem of analysis.problems) {
      warnings.push({
        code: 'unresolved-import',
        message: problem,
        file: analysis.path
      })
    }
  }
  if (input.unassignedFiles.length > 0) {
    warnings.push({
      code: 'unassigned-files',
      message: `${input.unassignedFiles.length} source file(s) could not be attributed to a module.`
    })
  }

  const analysis: AnalysisSummary = {
    analyzedAt: new Date().toISOString(),
    analyzerVersion: ANALYZER_VERSION,
    durationMs: input.durationMs,
    fileCount: input.fileCount,
    skippedFileCount: input.skippedFileCount,
    loc: input.loc,
    languages: input.languages,
    sourceRoots: input.sourceRoots,
    aiAssisted: false,
    warnings: warnings.slice(0, 200)
  }

  const graph = createGraph({
    projectRoot: input.projectRoot,
    name: input.projectName,
    modules,
    edges: [...edgeMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    unassignedFiles: [...input.unassignedFiles].sort(),
    analysis
  })

  // Deterministic module order makes saved documents diff-friendly.
  graph.modules.sort((a, b) => a.id.localeCompare(b.id))
  void moduleById
  return graph
}
