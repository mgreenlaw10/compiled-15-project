/**
 * Chrome state: which modal is open, what the app is busy with, and the
 * banners.
 */

import type { Slice, UiSlice } from '../types'

export const createUiSlice: Slice<UiSlice> = (set) => ({
  dialog: null,
  busy: 'idle',
  error: null,
  notice: null,
  bottomTab: 'activity',

  openDialog(name) {
    set({ dialog: name })
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
