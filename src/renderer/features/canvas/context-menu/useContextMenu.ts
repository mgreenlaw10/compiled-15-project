/**
 * The canvas's right-click wiring.
 *
 * Returns the React Flow handlers plus whatever menu is currently open, so
 * `GraphCanvas` spreads three props and renders one element and otherwise
 * knows nothing about menus. Extending the menu is then a change to
 * `./items.ts` alone.
 */

import { useCallback, useState, type MouseEvent } from 'react'
import type { Edge, Node } from '@xyflow/react'

import type { MenuTarget } from './types'
import { useStore } from '../../../state/store'

export interface CanvasContextMenu {
  /** The open menu's target, or `null`. */
  target: MenuTarget | null
  close: () => void
  handlers: {
    onPaneContextMenu: (event: MouseEvent | globalThis.MouseEvent) => void
    onNodeContextMenu: (event: MouseEvent, node: Node) => void
    onEdgeContextMenu: (event: MouseEvent, edge: Edge) => void
  }
}

export function useContextMenu(flow: { screenToFlowPosition(position: { x: number; y: number }): { x: number; y: number } } | null): CanvasContextMenu {
  const [target, setTarget] = useState<MenuTarget | null>(null)

  const open = useCallback(
    (
      event: MouseEvent | globalThis.MouseEvent,
      make: (position: { x: number; y: number }) => MenuTarget
    ) => {
      event.preventDefault()
      event.stopPropagation()
      if (!flow) return
      const position = { x: event.clientX, y: event.clientY }
      setTarget({ ...make(position), flowPosition: flow.screenToFlowPosition(position) })
    },
    [flow]
  )

  const close = useCallback(() => setTarget(null), [])

  return {
    target,
    close,
    handlers: {
      onPaneContextMenu: useCallback(
        (event: MouseEvent | globalThis.MouseEvent) =>
          open(event, (position) => ({ kind: 'pane', position })),
        [open]
      ),
      onNodeContextMenu: useCallback(
        (event: MouseEvent, node: Node) => {
          useStore.getState().select(node.id)
          open(event, (position) => ({
            kind: 'module',
            moduleId: node.id,
            position
          }))
        },
        [open]
      ),
      onEdgeContextMenu: useCallback(
        (event: MouseEvent, edge: Edge) =>
          open(event, (position) => ({
            kind: 'edge',
            edgeId: edge.id,
            position
          })),
        [open]
      )
    }
  }
}
