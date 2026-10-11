/**
 * The dialog registry.
 *
 * ---------------------------------------------------------------------------
 * Adding a dialog
 * ---------------------------------------------------------------------------
 * 1. Add its name to `DialogName` in `state/types.ts`.
 * 2. Write `./YourDialog.tsx`.
 * 3. Add one entry below.
 *
 * `openDialog('your-dialog')` then works from anywhere. The host in
 * `./index.tsx` renders whatever is registered, so it never needs editing, and
 * `DIALOGS` is typed as a total map over `DialogName` — a dialog named in the
 * union but not registered here fails the type check rather than opening as a
 * blank screen.
 */

import type { ComponentType } from 'react'

import type { DialogName } from '../../state/store'
import { AddModuleDialog } from './AddModuleDialog'
import { DeleteModuleDialog } from './DeleteModuleDialog'
import { DiffViewerDialog } from './DiffViewerDialog'
import { GenerateDialog } from './GenerateDialog'
import { SettingsDialog } from './SettingsDialog'

/** Every dialog name except `null`, which means "no dialog". */
export type OpenDialogName = Exclude<DialogName, null>

export const DIALOGS: Record<OpenDialogName, ComponentType> = {
  'add-module': AddModuleDialog,
  'delete-module': DeleteModuleDialog,
  settings: SettingsDialog,
  diff: DiffViewerDialog,
  generate: GenerateDialog
}
