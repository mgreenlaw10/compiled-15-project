/**
 * The right-click menu: appearance and behaviour.
 *
 * Knows nothing about what the menu contains — that is `./items.ts`. Closes on
 * Escape, on any click outside it, and after running an item.
 */

import { useEffect, useRef } from 'react'

import { useStore } from '../../../state/store'
import { itemsFor } from './items'
import type { MenuItem, MenuTarget } from './types'

/** Keeps the menu inside the viewport when the click was near an edge. */
function clampToViewport(
  x: number,
  y: number,
  element: HTMLElement | null
): { left: number; top: number } {
  if (!element) return { left: x, top: y }
  const { offsetWidth: w, offsetHeight: h } = element
  return {
    left: Math.min(x, Math.max(0, window.innerWidth - w - 8)),
    top: Math.min(y, Math.max(0, window.innerHeight - h - 8))
  }
}

export interface ContextMenuProps {
  target: MenuTarget
  onClose: () => void
  /** Overrides the registered items. For tests. */
  items?: readonly MenuItem[]
}

export function ContextMenu({
  target,
  onClose,
  items
}: ContextMenuProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const state = useStore()
  const visible = itemsFor(target, items)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const { left, top } = clampToViewport(
      target.position.x,
      target.position.y,
      element
    )
    element.style.left = `${left}px`
    element.style.top = `${top}px`
  }, [target])

  if (visible.length === 0) return null

  return (
    <div
      className="context-menu"
      ref={ref}
      role="menu"
      style={{ left: target.position.x, top: target.position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {visible.map((item) => {
        const reason = item.disabled?.({ target, state })
        const isDisabled = typeof reason === 'string'
        return (
          <div key={item.id}>
            {item.separatorBefore ? <div className="context-menu-sep" /> : null}
            <button
              role="menuitem"
              className={item.danger ? 'context-menu-item is-danger' : 'context-menu-item'}
              disabled={isDisabled}
              title={isDisabled ? reason : undefined}
              onClick={() => {
                item.run({ target, state })
                onClose()
              }}
            >
              <span>{item.label}</span>
              {item.accelerator ? (
                <span className="context-menu-accel">{item.accelerator}</span>
              ) : null}
            </button>
          </div>
        )
      })}
    </div>
  )
}
