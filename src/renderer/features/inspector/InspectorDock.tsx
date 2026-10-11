import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

const DEFAULT_WIDTH = 340
const KEYBOARD_STEP = 20

/** Reserve the normal sidebar width; extra width overlays the canvas. */
export function InspectorDock({ children }: { children: ReactNode }): JSX.Element {
  const dock = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [maxWidth, setMaxWidth] = useState(DEFAULT_WIDTH)
  const [resizing, setResizing] = useState(false)

  const measureLimit = useCallback((): number => {
    const workspace = dock.current?.parentElement
    const workspaceWidth = workspace?.getBoundingClientRect().width || window.innerWidth
    const leftWidth = workspace?.querySelector('.pane--left')?.getBoundingClientRect().width || 280
    return Math.max(DEFAULT_WIDTH, Math.floor(workspaceWidth - leftWidth))
  }, [])

  useEffect(() => {
    const update = (): void => {
      const limit = measureLimit()
      setMaxWidth(limit)
      setWidth((current) => Math.min(current, limit))
    }
    update()
    const observer = new ResizeObserver(update)
    if (dock.current?.parentElement) observer.observe(dock.current.parentElement)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [measureLimit])

  const clamp = (value: number): number => Math.max(DEFAULT_WIDTH, Math.min(measureLimit(), Math.round(value)))
  const startResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.isPrimary === false || drag.current) return
    event.preventDefault()
    event.stopPropagation()
    drag.current = { startX: event.clientX, startWidth: width, pointerId: event.pointerId }
    if (typeof event.pointerId === 'number') event.currentTarget.setPointerCapture?.(event.pointerId)
    setResizing(true)
  }
  const finishResize = (): void => { drag.current = null; setResizing(false) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEYBOARD_STEP * 3 : KEYBOARD_STEP
    if (event.key === 'ArrowLeft') setWidth((current) => clamp(current + step))
    else if (event.key === 'ArrowRight') setWidth((current) => clamp(current - step))
    else if (event.key === 'Home') setWidth(DEFAULT_WIDTH)
    else if (event.key === 'End') setWidth(measureLimit())
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return <div className="inspector-dock" ref={dock}>
    <div className={`inspector-overlay${width > DEFAULT_WIDTH ? ' is-expanded' : ''}${resizing ? ' is-resizing' : ''}`}
      style={{ '--inspector-width': `${width}px` } as CSSProperties}>
      <div className="inspector-resize-handle" role="separator" aria-label="Resize inspector" aria-orientation="vertical"
        aria-valuemin={DEFAULT_WIDTH} aria-valuemax={maxWidth} aria-valuenow={width} aria-valuetext={`${width} pixels wide`}
        tabIndex={0} title="Drag left to expand over the graph. Double-click to reset."
        onPointerDown={startResize}
        onPointerMove={(event) => {
          if (drag.current && event.pointerId === drag.current.pointerId) setWidth(clamp(drag.current.startWidth + drag.current.startX - event.clientX))
        }}
        onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize}
        onDoubleClick={() => { finishResize(); setWidth(DEFAULT_WIDTH) }} onKeyDown={onKeyDown} />
      {children}
    </div>
  </div>
}
