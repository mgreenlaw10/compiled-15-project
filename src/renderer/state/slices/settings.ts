/**
 * Settings, as the renderer sees them.
 *
 * Only ever the `SettingsView` projection: API keys stay in the main process.
 */

import type { SettingsSlice, Slice } from '../types'

export const createSettingsSlice: Slice<SettingsSlice> = (set) => ({
  settings: null,

  async loadSettings() {
    try {
      set({ settings: await window.cartograph.getSettings() })
    } catch (error) {
      set({ error: (error as Error).message })
    }
  },

  async updateSettings(patch) {
    try {
      set({ settings: await window.cartograph.setSettings(patch) })
    } catch (error) {
      set({ error: (error as Error).message })
    }
  }
})
