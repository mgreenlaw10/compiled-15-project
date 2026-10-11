/**
 * The modal shell: overlay, titled frame, body, optional footer.
 *
 * Escape closes, and so does a click on the overlay itself but not inside the
 * frame — a misplaced click should never discard a half-filled form.
 */

import { useEffect, type ReactNode } from 'react'

export interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide
}: ModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={wide ? 'modal modal--wide' : 'modal'} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}
