/**
 * Chrome state: which modal is open, what the app is busy with, and the
 * banners.
 */

import type { Slice, UiSlice } from '../types'

/** Panel sizes the user can drag. Also the double-click reset targets. */
export const DEFAULT_LEFT_PANE_WIDTH = 280
export const DEFAULT_BOTTOM_PANEL_HEIGHT = 230

export const createUiSlice: Slice<UiSlice> = (set) => ({
  dialog: null,
  busy: 'idle',
  error: null,
  notice: null,
  bottomTab: 'activity',
  // The legend explains colours the canvas only uses once a module is
  // selected, so it starts out of the way; the minimap is useful immediately.
  showLegend: false,
  showMinimap: true,
  leftPaneWidth: DEFAULT_LEFT_PANE_WIDTH,
  bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,

  toggleLegend() {
    set((state) => ({ showLegend: !state.showLegend }))
  },

  toggleMinimap() {
    set((state) => ({ showMinimap: !state.showMinimap }))
  },

  setLeftPaneWidth(width) {
    set({ leftPaneWidth: width })
  },

  setBottomPanelHeight(height) {
    set({ bottomPanelHeight: height })
  },

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
