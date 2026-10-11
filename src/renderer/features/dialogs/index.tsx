/**
 * The dialog host.
 *
 * Renders whichever dialog the store says is open. Driven by `./registry.ts`,
 * so adding a dialog does not mean editing this file.
 */

import { useStore } from '../../state/store'
import { DIALOGS } from './registry'

export { DIALOGS, type OpenDialogName } from './registry'

export function Dialogs(): JSX.Element | null {
  const dialog = useStore((s) => s.dialog)
  if (dialog === null) return null

  const Dialog = DIALOGS[dialog]
  return Dialog ? <Dialog /> : null
}
