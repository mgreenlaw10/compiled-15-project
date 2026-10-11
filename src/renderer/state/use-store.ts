/**
 * The store instance.
 *
 * In its own module so `./selectors.ts` can subscribe to it without importing
 * `./store.ts`, which re-exports the selectors — that would be a cycle.
 * Components should import from `./store`, not from here.
 */

import { create } from 'zustand'

import {
  createDocumentSlice,
  createGenerationSlice,
  createGraphSlice,
  createLayoutSlice,
  createLogSlice,
  createProjectSlice,
  createSelectionSlice,
  createSessionSlice,
  createSettingsSlice,
  createUiSlice
} from './slices'
import type { AppState } from './types'

export const useStore = create<AppState>((...args) => {
  const get = args[1]

  return {
    ...createUiSlice(...args),
    ...createLogSlice(...args),
    ...createSessionSlice(...args),
    ...createSelectionSlice(...args),
    ...createSettingsSlice(...args),
    ...createLayoutSlice(...args),
    ...createGraphSlice(...args),
    ...createProjectSlice(...args),
    ...createDocumentSlice(...args),
    ...createGenerationSlice(...args),

    async init() {
      window.cartograph.onLog((event) => get().pushLog(event))
      await get().loadSettings()
    }
  }
})
