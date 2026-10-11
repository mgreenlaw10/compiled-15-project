/**
 * Opening and analyzing a project.
 */

import { dialog } from 'electron'

import type {
  AnalyzeOptions,
  AnalyzeResult,
  OpenProjectResult
} from '../../../shared/ipc'
import { PROJECT_CHANNELS } from '../../../shared/ipc'
import type { ArchitectureDocument, ProjectInfo } from '../../../shared/types/project'
import { readProjectInfo } from '../../../core/analyzer'
import { isUsableProjectDirectory } from '../../../core/pipeline'
import { loadDocument } from '../../services/document-store'
import { asString, type HandlerModule } from '../context'

export const projectHandlers: HandlerModule = (ctx) => {
  async function openProjectAt(root: string): Promise<OpenProjectResult> {
    const usable = await isUsableProjectDirectory(root)
    if (!usable.ok) {
      throw new Error(usable.reason ?? 'That directory cannot be opened')
    }
    const project: ProjectInfo = await readProjectInfo(root)
    ctx.log.info(`Opened ${project.name}`, root)
    return { canceled: false, project }
  }

  return {
    [PROJECT_CHANNELS.openProject]: async (): Promise<OpenProjectResult> => {
      const win = ctx.getWindow()
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: 'Open a project to map',
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: 'Open project'
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, project: null }
      }
      return openProjectAt(result.filePaths[0])
    },

    [PROJECT_CHANNELS.openProjectAt]: async (_e: unknown, root: unknown) =>
      openProjectAt(asString(root, 'root')),

    [PROJECT_CHANNELS.analyze]: async (
      _e: unknown,
      root: unknown,
      options: unknown
    ): Promise<AnalyzeResult> => {
      const projectRoot = asString(root, 'root')
      const opts = (options ?? {}) as AnalyzeOptions
      ctx.work.begin()

      const analyzed = await ctx.service.analyze(projectRoot, {
        extraIgnores: opts.extraIgnores,
        useAi: opts.useAi === true
      })

      let savedDocument: ArchitectureDocument | null = null
      try {
        savedDocument = await loadDocument(projectRoot)
        if (savedDocument) {
          ctx.log.info(
            `Found a saved architecture with ${savedDocument.operations.length} recorded edit(s)`
          )
        }
      } catch (error) {
        ctx.log.warn(
          'A saved architecture could not be read',
          (error as Error).message
        )
      }

      return {
        project: analyzed.project,
        graph: analyzed.graph,
        layout: analyzed.layout,
        fileTree: analyzed.fileTree,
        savedDocument
      }
    }
  }
}
