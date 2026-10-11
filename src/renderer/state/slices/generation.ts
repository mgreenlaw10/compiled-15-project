/**
 * Planning a change set, previewing it, and writing it.
 *
 * `generate` plans and writes directly to the source project. Separate plan
 * and apply actions remain available for reviewing or exporting changes.
 */

import type { GenerationSlice, Slice } from '../types'
import { applyOperation } from '../../../shared/graph/apply-operation'

export const createGenerationSlice: Slice<GenerationSlice> = (set, get) => ({
  changeSet: null,
  diffs: null,
  applyResult: null,
  validation: null,

  async generate(useAi) {
    if (get().busy !== 'idle') return
    set({ changeSet: null, applyResult: null, validation: null })
    await get().plan(useAi)
    if (get().error || !get().changeSet) return
    if (!get().changeSet!.changes.length) {
      set({ bottomTab: 'changes' })
      return
    }
    await get().apply({ mode: 'in-place', createBackup: true, validate: true })
  },

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

    set({ busy: 'planning', error: null, bottomTab: 'changes', diffs: null })
    try {
      // Already written operations still establish identities and ownership
      // needed by subsequent edits, even though their source changes are skipped.
      let baseline = original
      for (const op of operations.filter((op) => appliedOperationIds.includes(op.id))) {
        const result = applyOperation(baseline, op)
        if (result.ok) baseline = result.graph
      }
      const changeSet = await window.cartograph.planChanges(project.root, {
        graph: baseline,
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
          ...new Set([...get().appliedOperationIds, ...(options.mode === 'in-place' ? result.appliedOperationIds : [])])
        ],
        dirty: true
      })

      // After writing over the project itself, the analyzed architecture is
      // stale; re-analyze so the graph reflects what is now on disk.
      if (options.mode === 'in-place' && result.errors.length === 0 &&
        changeSet.outcomes.every((outcome) => ['applied', 'metadata_only'].includes(outcome.status))) {
        await get().analyze({ useAi: false, force: true })
        set({
          changeSet,
          applyResult: result,
          validation: result.validation,
          bottomTab: 'results',
          notice:
            'Applied the changes to the project and re-analyzed it from the new source.'
        })
      } else if (options.mode === 'in-place') {
        set({ notice: 'Wrote the generated source changes. Unfinished edits remain pending; see the generation results.' })
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
