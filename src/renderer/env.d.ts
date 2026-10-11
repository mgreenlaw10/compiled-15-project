/// <reference types="vite/client" />

import type { CartographApi } from '../shared/ipc'

declare global {
  interface Window {
    /**
     * The only backend surface the renderer can reach, installed by the
     * preload script. See src/preload/index.ts.
     */
    cartograph: CartographApi
  }
}

export {}
