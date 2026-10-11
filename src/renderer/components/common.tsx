/**
 * Small shared UI pieces: modal, banner, badge, form fields.
 *
 * Deliberately plain. No component library, so the whole visual vocabulary of
 * the app is these few elements plus `styles/app.css`.
 */

import {
  useEffect,
  type ChangeEvent,
  type ReactNode
} from 'react'

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

export type BannerKind = 'error' | 'warn' | 'info' | 'ok'

export function Banner({
  kind,
  children,
  onClose
}: {
  kind: BannerKind
  children: ReactNode
  onClose?: () => void
}): JSX.Element {
  return (
    <div className={`banner banner--${kind}`}>
      <div style={{ flex: 1 }}>{children}</div>
      {onClose ? (
        <button className="banner-close" onClick={onClose} aria-label="Dismiss">
          ✕
        </button>
      ) : null}
    </div>
  )
}

export function Badge({
  kind = 'default',
  children,
  title
}: {
  kind?: 'default' | 'pending' | 'ok' | 'danger' | 'ai' | 'info'
  children: ReactNode
  title?: string
}): JSX.Element {
  return (
    <span
      className={kind === 'default' ? 'badge' : `badge badge--${kind}`}
      title={title}
    >
      {children}
    </span>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  )
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  type = 'text',
  autoFocus
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: ReactNode
  placeholder?: string
  type?: 'text' | 'password'
  autoFocus?: boolean
}): JSX.Element {
  return (
    <Field label={label} hint={hint}>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.value)
        }
      />
    </Field>
  )
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  rows = 3,
  placeholder
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: ReactNode
  rows?: number
  placeholder?: string
}): JSX.Element {
  return (
    <Field label={label} hint={hint}>
      <textarea
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
          onChange(event.target.value)
        }
      />
    </Field>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: ReactNode
}): JSX.Element {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="checkbox-text">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  )
}

export function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <div className="section-title">{children}</div>
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>
}

/** Renders a unified diff with per-line colouring. */
export function DiffBlock({ patch }: { patch: string }): JSX.Element {
  const lines = patch.split('\n')
  return (
    <pre className="diff">
      {lines.map((line, index) => {
        let className = ''
        if (line.startsWith('+++') || line.startsWith('---')) className = 'meta'
        else if (line.startsWith('@@')) className = 'hunk'
        else if (line.startsWith('+')) className = 'add'
        else if (line.startsWith('-')) className = 'del'
        else if (line.startsWith('=')) className = 'meta'
        return (
          <span key={index} className={className}>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString(undefined, { hour12: false })
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}
