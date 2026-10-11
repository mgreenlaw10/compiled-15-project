import { useLayoutEffect, useRef } from 'react'

export interface CanvasMenuItem {
  label: string
  action: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

/** A viewport-clamped menu with mouse and keyboard dismissal/navigation. */
export function CanvasContextMenu({ x, y, title, items, onClose }: {
  x: number
  y: number
  title: string
  items: CanvasMenuItem[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = ref.current!
    const previous = document.activeElement as HTMLElement | null
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()

    const dismiss = (event: PointerEvent): void => {
      if (!menu.contains(event.target as globalThis.Node)) onClose()
    }
    const resize = (): void => onClose()
    const keys = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.stopPropagation()
        onClose()
        if (event.key === 'Escape') {
          event.preventDefault()
          previous?.focus()
        }
        return
      }
      // Do not let graph shortcuts delete a selected edge behind the menu.
      if (event.key === 'Delete' || event.key === 'Backspace') event.stopPropagation()
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    menu.addEventListener('keydown', keys)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      menu.removeEventListener('keydown', keys)
      window.removeEventListener('resize', resize)
    }
  }, [x, y, onClose])

  return (
    <div ref={ref} className="canvas-context-menu" role="menu" aria-label={title}
      style={{ left: x, top: y }} onContextMenu={(event) => event.preventDefault()}>
      <div className="canvas-menu-title">{title}</div>
      {items.map((item) => (
        <div key={item.label}>
          {item.separator ? <div className="canvas-menu-separator" role="separator" /> : null}
          <button role="menuitem" disabled={item.disabled}
            className={item.danger ? 'is-danger' : undefined}
            onClick={() => { onClose(); item.action() }}>
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}
