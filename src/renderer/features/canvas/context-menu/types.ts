/**
 * What a right-click menu is made of.
 *
 * An item is a description, not a component: a label, when it applies, and what
 * it does. That keeps the menu's appearance in one file (`./ContextMenu.tsx`)
 * and its contents in another (`./items.ts`), so the two can be worked on
 * without colliding.
 */

import type { ModuleId } from '../../../../shared/types/architecture'
import type { AppState } from '../../../state/store'

/** Where the right-click landed. */
export type MenuTarget = (
  | { kind: 'pane'; position: CanvasPoint }
  | { kind: 'module'; moduleId: ModuleId; position: CanvasPoint }
  | { kind: 'edge'; edgeId: string; position: CanvasPoint }
) & { flowPosition?: CanvasPoint }

/** Screen coordinates of the click, for positioning the menu. */
export interface CanvasPoint {
  x: number
  y: number
}

export interface MenuItemContext {
  target: MenuTarget
  /** A live snapshot of the store, for deciding what applies. */
  state: AppState
  fitView?: () => void
}

export interface MenuItem {
  /** Stable id, unique within the menu. */
  id: string
  label: string | ((ctx: MenuItemContext) => string)
  /** `true` to draw a separator above this item. */
  separatorBefore?: boolean
  /** Destructive items are drawn in the danger colour. */
  danger?: boolean
  /** Shown right-aligned, e.g. `Ctrl+L`. Display only — it binds nothing. */
  accelerator?: string
  /** Which targets this item applies to. Omit for all of them. */
  appliesTo?: readonly MenuTarget['kind'][]
  /** `false` hides the item entirely; prefer `disabled` when the reason matters. */
  visible?: (ctx: MenuItemContext) => boolean
  /** A reason string disables the item and explains why on hover. */
  disabled?: (ctx: MenuItemContext) => string | false
  run: (ctx: MenuItemContext) => void
}
