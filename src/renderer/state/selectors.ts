/**
 * Derived values.
 *
 * These are hooks rather than plain selectors on purpose. A zustand selector
 * that builds a new object or array returns a fresh reference on every call,
 * which under `useSyncExternalStore` re-renders forever ("maximum update depth
 * exceeded"). Subscribing to the raw slices and deriving with `useMemo` keeps
 * the reference stable for as long as the inputs are.
 */

import { useMemo } from 'react'

import type { ModuleId } from '../../shared/types/architecture'
import { diffArchitectures, summarizeDiff } from '../../shared/graph/diff'
import { isStructural, type GraphOperation } from '../../shared/types/operations'
import { useStore } from './use-store'
import type { AppState } from './types'

function pendingFrom(
  operations: GraphOperation[],
  applied: string[]
): GraphOperation[] {
  if (applied.length === 0) return operations
  const done = new Set(applied)
  return operations.filter((op) => !done.has(op.id))
}

export function usePendingOperations(): GraphOperation[] {
  const operations = useStore((s) => s.operations)
  const applied = useStore((s) => s.appliedOperationIds)
  return useMemo(() => pendingFrom(operations, applied), [operations, applied])
}

/** Modules affected by at least one operation that has not reached the code. */
export function useModulesWithPendingChanges(): Set<ModuleId> {
  const pending = usePendingOperations()
  return useMemo(() => {
    const ids = new Set<ModuleId>()
    for (const op of pending) {
      if (!isStructural(op)) continue
      switch (op.type) {
        case 'add_module':
          ids.add(op.module.id)
          break
        case 'rename_module':
        case 'delete_module':
        case 'scaffold_module':
          ids.add(op.moduleId)
          break
        case 'move_file':
        case 'move_symbol':
        case 'move_responsibility':
          ids.add(op.fromModuleId)
          ids.add(op.toModuleId)
          break
        default:
          break
      }
    }
    return ids
  }, [pending])
}

export interface PendingSummary {
  structural: number
  metadata: number
  text: string
}

export function usePendingSummary(): PendingSummary {
  const pending = usePendingOperations()
  const hasProject = useStore((s) => s.original !== null)
  return useMemo(() => {
    const structural = pending.filter(isStructural).length
    const metadata = pending.length - structural

    if (pending.length === 0) {
      return {
        structural,
        metadata,
        text: hasProject ? 'Graph matches the source code' : 'No project open'
      }
    }
    const parts: string[] = []
    if (structural > 0) {
      parts.push(
        `${structural} change${structural === 1 ? '' : 's'} not yet in the code`
      )
    }
    if (metadata > 0) {
      parts.push(`${metadata} documentation edit${metadata === 1 ? '' : 's'}`)
    }
    return { structural, metadata, text: parts.join(', ') }
  }, [pending, hasProject])
}

export function useArchitectureDiffText(): string {
  const original = useStore((s) => s.original)
  const desired = useStore((s) => s.desired)
  return useMemo(
    () =>
      original && desired
        ? summarizeDiff(diffArchitectures(original, desired))
        : '',
    [original, desired]
  )
}

/**
 * The non-hook form, for slices, tests, and any caller that already holds a
 * state snapshot rather than being inside a component.
 */
export function pendingOperations(state: AppState): GraphOperation[] {
  return pendingFrom(state.operations, state.appliedOperationIds)
}
