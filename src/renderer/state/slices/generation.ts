/**
 * Planning a change set, previewing it, and writing it.
 *
 * Nothing here writes to disk by itself: `plan` asks the backend what it would
 * do, `loadDiffs` renders that, and only `apply` commits — which is why the
 * generate dialog can show the whole consequence before anything happens.
 */

import type { GenerationSlice, Slice } from '../types'

export const createGenerationSlice: Slice<GenerationSlice> = (set, get) => ({
  changeSet: null,
  diffs: null,
  applyResult: null,
  validation: null,

  async plan(useAi) {
    const { project, original, operations, appliedOperationIds } = get()
    if (!project || !original) return

    const pending = operations.filter((op) => !appliedOperationIds.includes(op.id))
    if (pending.length === 0) {
      set({
        notice:
          'There is nothing to generate: no architectural edits are waiting to be applied.'
      })
      return
    }

    set({ busy: 'planning', error: null, bottomTab: 'changes', deskMode: 'review', diffs: null })
    try {
      const changeSet = await window.cartograph.planChanges(project.root, {
        graph: original,
        operations: pending,
        useAi
      })
      set({ changeSet, busy: 'idle' })
      await get().loadDiffs()
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async loadDiffs() {
    const changeSet = get().changeSet
    if (!changeSet) return
    try {
      set({ diffs: await window.cartograph.previewDiff(changeSet) })
    } catch (error) {
      set({ error: (error as Error).message })
    }
  },

  async apply(options) {
    const { project, changeSet } = get()
    if (!project || !changeSet) return

    set({ busy: 'applying', error: null, bottomTab: 'results' })
    try {
      const result = await window.cartograph.applyChanges(project.root, {
        mode: options.mode,
        outputDirectory: options.outputDirectory,
        createBackup: options.createBackup,
        validate: options.validate,
        changeSet
      })
      set({
        applyResult: result,
        validation: result.validation,
        busy: 'idle',
        dialog: null,
        appliedOperationIds: [
          ...new Set([...get().appliedOperationIds, ...result.appliedOperationIds])
        ],
        dirty: true
      })

      // After writing over the project itself, the analyzed architecture is
      // stale; re-analyze so the graph reflects what is now on disk.
      if (options.mode === 'in-place' && result.errors.length === 0) {
        await get().analyze({ useAi: false })
        set({
          notice:
            'Applied the changes to the project and re-analyzed it from the new source.'
        })
      } else if (result.errors.length === 0) {
        set({
          notice: `Generated the project into ${result.outputDirectory}. The original project was not modified.`
        })
      }
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async validateCurrent() {
    const project = get().project
    if (!project) return
    set({ busy: 'validating', error: null, bottomTab: 'results' })
    try {
      const validation = await window.cartograph.validateProject(project.root)
      set({ validation, busy: 'idle' })
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  discardPlan() {
    set({ changeSet: null, diffs: null, dialog: null })
  }
})
