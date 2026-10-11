/**
 * Chrome state: which modal is open, what the app is busy with, and the
 * banners.
 */

import type { Slice, UiSlice } from '../types'

export const createUiSlice: Slice<UiSlice> = (set) => ({
  dialog: null,
  addModulePosition: null,
  deskMode: 'review',
  focusConnections: false,
  busy: 'idle',
  error: null,
  notice: null,
  bottomTab: 'preview',

  openDialog(name, position) {
    set({ dialog: name, addModulePosition: name === 'add-module' ? position ?? null : null })
  },

  setDeskMode(mode) {
    set({ deskMode: mode, bottomTab: mode === 'review' ? 'preview' : 'module' })
  },

  setFocusConnections(enabled) {
    set({ focusConnections: enabled })
  },

  setBottomTab(tab) {
    set({ bottomTab: tab })
  },

  setError(message) {
    set({ error: message })
  },

  setNotice(message) {
    set({ notice: message })
  }
})
