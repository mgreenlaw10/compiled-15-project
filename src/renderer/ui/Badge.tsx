/**
 * A small coloured label. `kind` carries the meaning, not decoration.
 */

import type { ReactNode } from 'react'

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
