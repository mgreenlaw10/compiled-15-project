/**
 * Dragging a panel edge to resize it.
 *
 * Pointer events rather than mouse events, so a trackpad, a touchscreen and a
 * pen all work, and with pointer capture so the drag survives the cursor
 * leaving the handle — without it, dragging quickly past the edge drops the
 * gesture, which feels broken.
 *
 * Keyboard and double-click are handled too: a resize handle that only responds
 * to a precise drag is unusable for anyone who cannot make one.
 */

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

/** How far an arrow key moves the edge. Shift multiplies it. */
const KEYBOARD_STEP = 20

export interface DragSizeOptions {
  /** Current size, owned by the caller so it can be persisted. */
  value: number
  onChange: (value: number) => void
  min: number
  /** Recomputed on each drag, since it usually depends on window size. */
  max: () => number
  /** Double-click and Home reset to this. */
  initial: number
  /**
   * Which way the handle moves relative to the growing panel.
   *
   * `'start'` — the handle is on the panel's leading edge, so dragging towards
   * the origin makes it bigger (a right sidebar, a bottom panel).
   * `'end'` — the handle is on the trailing edge (a left sidebar).
   */
  from: 'start' | 'end'
  axis: 'x' | 'y'
}

export interface DragSize {
  resizing: boolean
  /** Spread onto the handle element. */
  handleProps: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void
    onPointerMove: (event: PointerEvent<HTMLElement>) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onLostPointerCapture: () => void
    onDoubleClick: () => void
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
    tabIndex: number
    role: string
    'aria-orientation': 'horizontal' | 'vertical'
    'aria-valuemin': number
    'aria-valuenow': number
    'aria-valuetext': string
  }
}

export function useDragSize(options: DragSizeOptions): DragSize {
  const drag = useRef<{ start: number; startSize: number; pointerId: number } | null>(
    null
  )
  const [resizing, setResizing] = useState(false)

  const clamp = useCallback(
    (value: number): number =>
      Math.max(options.min, Math.min(options.max(), Math.round(value))),
    [options]
  )

  const coordinate = (event: PointerEvent<HTMLElement>): number =>
    options.axis === 'x' ? event.clientX : event.clientY

  const finish = useCallback(() => {
    drag.current = null
    setResizing(false)
  }, [])

  return {
    resizing,
    handleProps: {
      onPointerDown: (event) => {
        if (event.button !== 0 || event.isPrimary === false || drag.current) return
        event.preventDefault()
        event.stopPropagation()
        drag.current = {
          start: coordinate(event),
          startSize: options.value,
          pointerId: event.pointerId
        }
        if (typeof event.pointerId === 'number') {
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }
        setResizing(true)
      },

      onPointerMove: (event) => {
        const current = drag.current
        if (!current || event.pointerId !== current.pointerId) return
        const delta = coordinate(event) - current.start
        options.onChange(
          clamp(current.startSize + (options.from === 'start' ? -delta : delta))
        )
      },

      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,

      onDoubleClick: () => {
        finish()
        options.onChange(options.initial)
      },

      onKeyDown: (event) => {
        const step = (event.shiftKey ? KEYBOARD_STEP * 3 : KEYBOARD_STEP)
        // Grow in the direction the panel actually grows, so the arrow key
        // that looks like "bigger" is the one that makes it bigger.
        const grow = options.from === 'start' ? -1 : 1
        const keys =
          options.axis === 'x'
            ? { less: 'ArrowLeft', more: 'ArrowRight' }
            : { less: 'ArrowUp', more: 'ArrowDown' }

        if (event.key === keys.less) options.onChange(clamp(options.value - step * grow))
        else if (event.key === keys.more) {
          options.onChange(clamp(options.value + step * grow))
        } else if (event.key === 'Home') options.onChange(options.initial)
        else if (event.key === 'End') options.onChange(options.max())
        else return

        event.preventDefault()
        event.stopPropagation()
      },

      tabIndex: 0,
      role: 'separator',
      'aria-orientation': options.axis === 'x' ? 'vertical' : 'horizontal',
      'aria-valuemin': options.min,
      'aria-valuenow': options.value,
      'aria-valuetext': `${options.value} pixels`
    }
  }
}
