/**
 * The store instance.
 *
 * In its own module so `./selectors.ts` can subscribe to it without importing
 * `./store.ts`, which re-exports the selectors — that would be a cycle.
 * Components should import from `./store`, not from here.
 */

import { create } from 'zustand'

import {
  createCollabSlice,
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
    ...createCollabSlice(...args),

    async init() {
      window.cartograph.onLog((event) => get().pushLog(event))
      // Collaboration state is pushed rather than polled from the renderer:
      // the backend already polls Git, and a second timer here would just
      // duplicate it.
      window.cartograph.onCollabChanged((snapshot) =>
        get().receiveSnapshot(snapshot)
      )
      await get().loadSettings()
    }
  }
})
