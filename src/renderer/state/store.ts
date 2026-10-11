/**
 * The renderer's state, as components see it.
 *
 * Every field and action lives in a slice under `./slices`; the store is
 * assembled in `./use-store.ts`. Keeping the composition that small is the
 * point — adding state means editing one slice, not the one file the whole
 * team has open.
 *
 * Import from here. The split below is an implementation detail:
 *
 *   ./types.ts      the state shape, one interface per slice
 *   ./slices/       the state and actions themselves
 *   ./selectors.ts  derived values (hooks)
 *   ./use-store.ts  the zustand instance
 */

export { useStore } from './use-store'
export * from './selectors'
export type {
  AppState,
  BottomTab,
  Busy,
  DialogName,
  DocumentSlice,
  GenerationSlice,
  GraphSlice,
  LayoutSlice,
  LogSlice,
  ProjectSlice,
  SelectionSlice,
  SessionSlice,
  SettingsSlice,
  Slice,
  UiSlice
} from './types'
