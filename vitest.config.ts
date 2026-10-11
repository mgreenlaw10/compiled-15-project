import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core')
    }
  },
  test: {
    // Node by default; the UI tests opt into jsdom with a file-level comment
    // pragma so the backend tests keep running in a plain Node environment.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environmentMatchGlobs: [['tests/ui/**', 'jsdom']],
    setupFiles: ['tests/ui/setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    reporters: ['default']
  }
})
