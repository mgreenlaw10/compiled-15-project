/**
 * Planning, previewing, writing and validating generated changes.
 */

import { GENERATION_CHANNELS } from '../../../shared/ipc'
import type {
  ApplyRequest,
  ChangeSet,
  PlanRequest
} from '../../../shared/types/generation'
import { asString, type HandlerModule } from '../context'

export const generationHandlers: HandlerModule = (ctx) => ({
  [GENERATION_CHANNELS.planChanges]: async (
    _e: unknown,
    root: unknown,
    req: unknown
  ) => {
    const projectRoot = asString(root, 'root')
    const request = req as PlanRequest
    if (!Array.isArray(request?.operations)) {
      throw new Error('planChanges needs an operations array')
    }
    if (!request.graph?.modules) {
      throw new Error('planChanges needs the current graph')
    }

    ctx.work.begin()
    return ctx.service.plan({
      projectRoot,
      graph: request.graph,
      operations: request.operations,
      useAi: request.useAi === true
    })
  },

  [GENERATION_CHANNELS.previewDiff]: async (_e: unknown, changeSet: unknown) => {
    const set = changeSet as ChangeSet
    if (!Array.isArray(set?.changes)) {
      throw new Error('previewDiff needs a change set')
    }
    return ctx.service.previewDiff(set)
  },

  [GENERATION_CHANNELS.applyChanges]: async (
    _e: unknown,
    root: unknown,
    req: unknown
  ) => {
    const projectRoot = asString(root, 'root')
    const request = req as ApplyRequest
    if (!request?.changeSet) throw new Error('applyChanges needs a change set')
    if (request.mode !== 'in-place' && request.mode !== 'new-directory') {
      throw new Error(`Unknown write mode "${String(request.mode)}"`)
    }
    ctx.work.begin()
    return ctx.service.apply({
      projectRoot,
      changeSet: request.changeSet,
      mode: request.mode,
      outputDirectory: request.outputDirectory,
      createBackup: request.createBackup !== false,
      validate: request.validate !== false
    })
  },

  [GENERATION_CHANNELS.validateProject]: async (_e: unknown, root: unknown) => {
    ctx.work.begin()
    return ctx.service.validate(asString(root, 'root'))
  }
})
