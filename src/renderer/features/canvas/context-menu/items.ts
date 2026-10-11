/**
 * What the canvas right-click menu offers.
 *
 * ---------------------------------------------------------------------------
 * Adding an item
 * ---------------------------------------------------------------------------
 * Add a `MenuItem` to `CANVAS_MENU_ITEMS` below. Say which targets it applies
 * to, and prefer `disabled` over `visible` when there is a reason worth
 * telling the user — a menu whose items appear and vanish is harder to learn
 * than one where they grey out.
 *
 * `run` receives a live store snapshot, so an item calls store actions
 * directly and needs no props threading from the canvas.
 *
 * The items below are the commands that already existed as menu entries and
 * keyboard shortcuts; this file is where a richer menu goes.
 */

import { useStore } from '../../../state/store'
import type { MenuItem } from './types'
import { isOverviewEdge } from '../edges/module-edges'

export const CANVAS_MENU_ITEMS: readonly MenuItem[] = [
  {
    id: 'add-module',
    label: 'Add module…',
    accelerator: 'Ctrl+Shift+N',
    appliesTo: ['pane'],
    run: ({ state }) => state.openDialog('add-module')
  },
  {
    id: 'auto-layout',
    label: 'Auto layout',
    accelerator: 'Ctrl+L',
    appliesTo: ['pane'],
    disabled: ({ state }) =>
      state.desired === null ? 'No project is open' : false,
    run: ({ state }) => state.relayout()
  },
  {
    id: 'module-expand',
    label: 'Show files',
    appliesTo: ['module'],
    visible: ({ state, target }) =>
      target.kind === 'module' && state.layout.expanded[target.moduleId] !== true,
    run: ({ state, target }) => {
      if (target.kind === 'module') state.setExpanded(target.moduleId, true)
    }
  },
  {
    id: 'module-collapse',
    label: 'Hide files',
    appliesTo: ['module'],
    visible: ({ state, target }) =>
      target.kind === 'module' && state.layout.expanded[target.moduleId] === true,
    run: ({ state, target }) => {
      if (target.kind === 'module') state.setExpanded(target.moduleId, false)
    }
  },
  {
    id: 'module-delete',
    label: 'Delete module…',
    appliesTo: ['module'],
    separatorBefore: true,
    danger: true,
    run: ({ state, target }) => {
      if (target.kind !== 'module') return
      state.select(target.moduleId)
      state.openDialog('delete-module')
    }
  },
  {
    id: 'edge-remove',
    label: 'Remove dependency',
    appliesTo: ['edge'],
    danger: true,
    disabled: ({ target }) => target.kind === 'edge' && isOverviewEdge(target.edgeId) ?
      'Select a module to show and remove individual dependencies.' : false,
    run: ({ state, target }) => {
      if (target.kind !== 'edge') return
      const edge = state.desired?.edges.find((e) => e.id === target.edgeId)
      if (!edge) return
      state.dispatchOperation({
        type: 'remove_dependency',
        from: edge.from,
        to: edge.to,
        kind: edge.kind
      })
    }
  }
]

/** The items that apply to one target, in display order. */
export function itemsFor(
  target: import('./types').MenuTarget,
  items: readonly MenuItem[] = CANVAS_MENU_ITEMS
): MenuItem[] {
  const state = useStore.getState()
  return items.filter((item) => {
    if (item.appliesTo && !item.appliesTo.includes(target.kind)) return false
    if (item.visible && !item.visible({ target, state })) return false
    return true
  })
}
