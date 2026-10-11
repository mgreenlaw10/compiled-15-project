/**
 * The analysis pipeline.
 *
 *   scan -> static analysis (per language) -> cluster -> build graph -> layout
 *
 * Each stage is a separate module with plain inputs and outputs, so the whole
 * pipeline runs in a unit test without Electron, and an individual stage can be
 * replaced (a different clusterer, another language) without touching the rest.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ArchitectureGraph, GraphLayout } from '../../shared/types/architecture'
import type { FileTreeNode, ProjectInfo } from '../../shared/types/project'
import { createLayout } from '../../shared/graph/model'
import { layoutGraph } from '../../shared/graph/layout'
import type { Logger } from '../logger'
import { silentLogger } from '../logger'
import { ANALYZER_VERSION, buildGraph } from './build-graph'
import { clusterFiles } from './cluster'
import { LanguageRegistry, nullAnalyzer, type FileAnalysis } from './languages'
import { TypeScriptAnalyzer } from './languages/typescript'
import { parseTsConfigPaths } from './resolve'
import { readProjectInfo, scanProject } from './scan'

export { ANALYZER_VERSION } from './build-graph'
export { readProjectInfo } from './scan'

export interface AnalyzeProjectOptions {
  extraIgnores?: string[]
  logger?: Logger
  /** Aborts a long analysis; checked between stages and every few files. */
  signal?: AbortSignal
}

export interface AnalyzeProjectResult {
  project: ProjectInfo
  graph: ArchitectureGraph
  layout: GraphLayout
  fileTree: FileTreeNode
  analyses: FileAnalysis[]
}

/** The registry used by the app. Add further languages here. */
export function createDefaultRegistry(): LanguageRegistry {
  return new LanguageRegistry().register(new TypeScriptAnalyzer())
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Analysis canceled')
}

export async function analyzeProject(
  root: string,
  options: AnalyzeProjectOptions = {}
): Promise<AnalyzeProjectResult> {
  const logger = options.logger ?? silentLogger
  const log = logger.child('analysis')
  const started = Date.now()

  const project = await readProjectInfo(root)
  log.info(`Scanning ${project.name}`, root)

  const scan = await scanProject(root, {
    extraIgnores: options.extraIgnores,
    onProgress: (count, current) => {
      if (count % 25 === 0) log.debug(`Scanned ${count} files`, current)
    }
  })
  throwIfAborted(options.signal)

  log.info(
    `Found ${scan.files.length} source file(s) in ${scan.totalFileCount} total; source root(s): ${
      scan.sourceRoots.map((r) => r || '(project root)').join(', ')
    }`
  )
  for (const skipped of scan.skipped.slice(0, 20)) {
    log.debug(`Skipped ${skipped.path}`, skipped.reason)
  }

  if (scan.files.length === 0) {
    log.warn(
      'No analyzable source files found. Cartograph currently reads TypeScript and JavaScript.'
    )
  }

  // tsconfig path aliases, so `@app/db` style imports resolve to real files.
  let pathAliases: Record<string, string[]> = {}
  let baseUrl = ''
  for (const name of ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json']) {
    try {
      const text = await fs.readFile(path.join(root, name), 'utf8')
      const parsed = parseTsConfigPaths(text)
      if (Object.keys(parsed.paths).length > 0 || parsed.baseUrl !== '') {
        pathAliases = parsed.paths
        baseUrl = parsed.baseUrl
        log.debug(
          `Using path aliases from ${name}`,
          Object.keys(parsed.paths).join(', ') || `baseUrl=${parsed.baseUrl}`
        )
        break
      }
    } catch {
      // No tsconfig, or unreadable: relative imports still resolve.
    }
  }

  const registry = createDefaultRegistry()
  const partitions = registry.partition(scan.files)
  const analyses: FileAnalysis[] = []

  for (const { analyzer, files } of partitions) {
    throwIfAborted(options.signal)
    if (analyzer.id === nullAnalyzer.id) {
      log.warn(
        `${files.length} file(s) have no registered analyzer and are treated as opaque.`
      )
    } else {
      log.info(`Analyzing ${files.length} ${analyzer.displayName} file(s)`)
    }
    const result = await analyzer.analyze(files, {
      projectRoot: root,
      allFiles: scan.files,
      pathAliases,
      baseUrl,
      onProgress: (done, total, current) => {
        if (done % 20 === 0 || done === total) {
          log.progress(`Parsed ${done}/${total} files`, done / Math.max(total, 1))
          log.debug(current)
        }
      }
    })
    analyses.push(...result)
  }
  throwIfAborted(options.signal)

  const unresolved = analyses.reduce((n, a) => n + a.problems.length, 0)
  const symbolCount = analyses.reduce((n, a) => n + a.symbols.length, 0)
  const importCount = analyses.reduce((n, a) => n + a.imports.length, 0)
  log.info(
    `Extracted ${symbolCount} symbol(s) and ${importCount} import(s)` +
      (unresolved > 0 ? `; ${unresolved} import(s) did not resolve` : '')
  )

  const clustered = clusterFiles(analyses, project.name, {
    sourceRoots: scan.sourceRoots
  })
  log.info(`Grouped files into ${clustered.modules.length} module(s)`)

  const graph = buildGraph({
    projectRoot: root,
    projectName: project.name,
    analyses,
    drafts: clustered.modules,
    unassignedFiles: clustered.unassigned,
    sourceRoots: scan.sourceRoots,
    fileCount: scan.files.length,
    skippedFileCount: scan.skipped.length,
    loc: scan.loc,
    languages: scan.languages,
    durationMs: Date.now() - started,
    warnings: scan.skipped.slice(0, 50).map((s) => ({
      code: 'skipped-file',
      message: `Skipped ${s.path}: ${s.reason}`,
      file: s.path
    }))
  })

  const layout = createLayout(layoutGraph(graph))

  log.success(
    `Analysis complete: ${graph.modules.length} module(s), ${graph.edges.length} dependency edge(s) in ${
      Date.now() - started
    } ms (analyzer ${ANALYZER_VERSION})`
  )

  return { project, graph, layout, fileTree: scan.tree, analyses }
}
