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

const idle = ({ state }: import('./types').MenuItemContext): string | false =>
  state.busy === 'idle' ? false : 'Wait for the current task to finish'

export const CANVAS_MENU_ITEMS: readonly MenuItem[] = [
  {
    id: 'module-expand', label: 'Show files', appliesTo: ['module'],
    visible: ({ state, target }) => target.kind === 'module' && !state.layout.expanded[target.moduleId],
    run: ({ state, target }) => { if (target.kind === 'module') state.setExpanded(target.moduleId, true) }
  },
  {
    id: 'module-collapse', label: 'Hide files', appliesTo: ['module'],
    visible: ({ state, target }) => target.kind === 'module' && state.layout.expanded[target.moduleId] === true,
    run: ({ state, target }) => { if (target.kind === 'module') state.setExpanded(target.moduleId, false) }
  },
  {
    id: 'module-focus', label: 'Focus connections', appliesTo: ['module'],
    run: ({ state }) => state.setFocusConnections(true)
  },
  {
    id: 'module-delete', label: 'Delete module…', appliesTo: ['module'], danger: true, disabled: idle,
    run: ({ state, target }) => {
      if (target.kind !== 'module') return
      state.select(target.moduleId)
      state.openDialog('delete-module')
    }
  },
  ...(['source', 'target'] as const).map((endpoint): MenuItem => ({
    id: `edge-inspect-${endpoint}`, appliesTo: ['edge'],
    label: ({ state, target }) => {
      const edge = target.kind === 'edge' ? state.desired?.edges.find((e) => e.id === target.edgeId) : undefined
      const id = endpoint === 'source' ? edge?.from : edge?.to
      return `Inspect ${endpoint}: ${state.desired?.modules.find((m) => m.id === id)?.name ?? 'module'}`
    },
    run: ({ state, target }) => {
      const edge = target.kind === 'edge' ? state.desired?.edges.find((e) => e.id === target.edgeId) : undefined
      if (edge) state.select(endpoint === 'source' ? edge.from : edge.to)
    }
  })),
  {
    id: 'edge-remove', label: 'Remove dependency', appliesTo: ['edge'], danger: true, disabled: idle,
    run: ({ state, target }) => {
      const edge = target.kind === 'edge' ? state.desired?.edges.find((e) => e.id === target.edgeId) : undefined
      if (edge) state.dispatchOperation({ type: 'remove_dependency', from: edge.from, to: edge.to })
    }
  },
  {
    id: 'add-module', label: 'Add module here…', separatorBefore: true,
    disabled: (ctx) => !ctx.state.desired ? 'No project is open' : idle(ctx),
    run: ({ state, target }) => state.openDialog('add-module', target.flowPosition)
  },
  {
    id: 'fit-view', label: 'Fit graph to view',
    run: ({ fitView }) => fitView?.()
  },
  {
    id: 'auto-layout', label: 'Auto layout', accelerator: 'Ctrl+L',
    disabled: (ctx) => !ctx.state.desired ? 'No project is open' : idle(ctx),
    run: ({ state }) => state.relayout()
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
