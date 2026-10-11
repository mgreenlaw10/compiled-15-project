/**
 * Section headings and empty states.
 */

import type { ReactNode } from 'react'

export function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <div className="section-title">{children}</div>
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>
}
