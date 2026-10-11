/**
 * Form fields.
 *
 * `Field` owns the label/hint layout; the rest are thin wrappers so a form
 * reads as a list of questions rather than a pile of markup.
 */

import type { ChangeEvent, ReactNode } from 'react'

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
