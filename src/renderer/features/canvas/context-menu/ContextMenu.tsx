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
    left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - h - 8))
  }
}

export interface ContextMenuProps {
  target: MenuTarget
  onClose: () => void
  onFitView?: () => void
  /** Overrides the registered items. For tests. */
  items?: readonly MenuItem[]
}

export function ContextMenu({
  target,
  onClose,
  onFitView,
  items
}: ContextMenuProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const state = useStore()
  const visible = itemsFor(target, items)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') onClose()
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      let next: number | undefined
      if (event.key === 'ArrowDown') next = (index + 1) % buttons.length
      if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = buttons.length - 1
      if (next !== undefined && buttons.length) {
        event.preventDefault()
        buttons[next].focus()
      }
    }
    const onDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onClose)
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
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [target])

  if (visible.length === 0) return null

  return (
    <div
      className="context-menu"
      ref={ref}
      role="menu"
      aria-label={target.kind === 'module' ? state.desired?.modules.find((m) => m.id === target.moduleId)?.name ?? 'Module' : target.kind === 'edge' ? 'Dependency' : 'Canvas'}
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
              aria-keyshortcuts={item.accelerator?.replace('Ctrl', 'Control')}
              className={item.danger ? 'context-menu-item is-danger' : 'context-menu-item'}
              disabled={isDisabled}
              title={isDisabled ? reason : undefined}
              onClick={() => {
                item.run({ target, state: useStore.getState(), fitView: onFitView })
                onClose()
              }}
            >
              <span>{typeof item.label === 'function' ? item.label({ target, state }) : item.label}</span>
              {item.accelerator ? (
                <span className="context-menu-accel" aria-hidden="true">{item.accelerator}</span>
              ) : null}
            </button>
          </div>
        )
      })}
    </div>
  )
}
