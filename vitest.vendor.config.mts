// T0: the vendored ZCode engine's own vitest suite, run in place. The dist-build check is left
// out: it inspects ZCode's tsc output (dist/projections.js), which this package does not ship.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('./vendor/dynamic-workflow', import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/projections-barrel.test.ts'],
  },
})
