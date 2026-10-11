/**
 * An inline message above the content it concerns.
 */

import type { ReactNode } from 'react'

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
