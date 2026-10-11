/**
 * The backend service interface.
 *
 * Everything the GUI can ask the backend to do goes through `CartographService`.
 * The Electron main process builds one of these and exposes it over IPC; the
 * tests build one directly; and a future collaborative server would implement
 * the same interface over a socket. Nothing in here knows about Electron,
 * React, or IPC.
 *
 * Code-generation work is modelled as a `GenerationTask` — a project, an
 * architecture, and a list of operations — which is deliberately a plain
 * serializable value so that a task can later be submitted by a remote user or
 * handed to a parallel AI agent.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ArchitectureGraph } from '../shared/types/architecture'
import type {
  ApplyResult,
  ChangeSet,
  ValidationReport,
  WriteMode
} from '../shared/types/generation'
import type { GraphOperation } from '../shared/types/operations'
import type { DiffPreview } from '../shared/ipc'
import { analyzeProject, type AnalyzeProjectResult } from './analyzer'
import { scanProject } from './analyzer/scan'
import { diffChangeSet } from './output/differ'
import { applyChangeSet } from './output/writer'
import { validateProject } from './output/validate'
import { planChanges } from './transform/engine'
import type { AiConfig } from '../shared/ai'
import type { Logger } from './logger'
import { silentLogger } from './logger'

export interface GenerationTask {
  projectRoot: string
  /** The architecture the operations are written against. */
  graph: ArchitectureGraph
  operations: GraphOperation[]
  useAi: boolean
}

export interface ApplyTask {
  projectRoot: string
  changeSet: ChangeSet
  mode: WriteMode
  outputDirectory?: string
  createBackup: boolean
  validate: boolean
}

export interface ServiceDeps {
  logger?: Logger
  /**
   * Supplies the AI configuration when a task asks for AI assistance. It is a
   * callback rather than a value so that no key is read — and the Anthropic
   * SDK is not even loaded — unless an operation genuinely needs a model.
   */
  getAiConfig?: () => Promise<AiConfig | null>
  signal?: () => AbortSignal | undefined
}

export interface CartographService {
  analyze(
    root: string,
    options?: { extraIgnores?: string[]; useAi?: boolean }
  ): Promise<AnalyzeProjectResult>
  loadSourceFiles(root: string): Promise<Map<string, string>>
  plan(task: GenerationTask): Promise<ChangeSet>
  previewDiff(changeSet: ChangeSet): DiffPreview[]
  apply(task: ApplyTask): Promise<ApplyResult>
  validate(root: string): Promise<ValidationReport>
}

/** Reads every analyzable source file in the project into memory. */
export async function loadSourceFiles(
  root: string,
  extraIgnores?: string[]
): Promise<Map<string, string>> {
  const scan = await scanProject(root, { extraIgnores })
  return new Map(scan.files.map((f) => [f.path, f.content]))
}

export function createService(deps: ServiceDeps = {}): CartographService {
  const logger = deps.logger ?? silentLogger

  return {
    async analyze(root, options) {
      const analyzed = await analyzeProject(root, {
        logger,
        extraIgnores: options?.extraIgnores,
        signal: deps.signal?.()
      })

      if (!options?.useAi || !deps.getAiConfig) return analyzed
      const config = await deps.getAiConfig()
      if (!config) {
        logger
          .child('ai')
          .warn(
            'AI-assisted analysis was requested but no API key is configured; using the analyzer’s own descriptions.'
          )
        return analyzed
      }

      // Loaded lazily so the Anthropic SDK is never pulled in for a key-less run.
      const { enrichGraphWithAi } = await import('./ai/enrich')
      const enriched = await enrichGraphWithAi(analyzed.graph, {
        config,
        logger,
        signal: deps.signal?.()
      })
      return { ...analyzed, graph: enriched.graph }
    },

    loadSourceFiles,

    async plan(task) {
      const files = await loadSourceFiles(task.projectRoot)

      let ai = null
      if (task.useAi) {
        const config = deps.getAiConfig ? await deps.getAiConfig() : null
        if (config) {
          const { createAiTransformer } = await import('./ai/transformer')
          ai = createAiTransformer({
            config,
            logger,
            signal: deps.signal?.()
          })
        } else {
          logger
            .child('generation')
            .warn(
              'AI-assisted transformations were requested but no API key is configured; only deterministic operations will run.'
            )
        }
      }
      const { changeSet } = await planChanges(task.graph, task.operations, files, {
        logger,
        ai,
        signal: deps.signal?.()
      })
      return changeSet
    },

    previewDiff(changeSet) {
      return diffChangeSet(changeSet)
    },

    async apply(task) {
      const result = await applyChangeSet(task.projectRoot, task.changeSet, {
        mode: task.mode,
        outputDirectory: task.outputDirectory,
        createBackup: task.createBackup,
        logger
      })

      if (task.validate && result.errors.length === 0) {
        result.validation = await validateProject(result.outputDirectory, {
          logger,
          signal: deps.signal?.()
        })
      } else if (task.validate) {
        logger
          .child('validation')
          .warn('Skipped validation because some files could not be written.')
      }
      return result
    },

    async validate(root) {
      return validateProject(root, { logger, signal: deps.signal?.() })
    }
  }
}

/** `true` when `root` looks like a directory Cartograph can open. */
export async function isUsableProjectDirectory(
  root: string
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) return { ok: false, reason: 'Not a directory' }
  } catch {
    return { ok: false, reason: 'That path does not exist' }
  }
  try {
    await fs.readdir(root)
  } catch {
    return { ok: false, reason: 'That directory cannot be read' }
  }
  if (path.resolve(root) === path.parse(path.resolve(root)).root) {
    return {
      ok: false,
      reason: 'Refusing to analyze a filesystem root; pick a project directory'
    }
  }
  return { ok: true }
}
