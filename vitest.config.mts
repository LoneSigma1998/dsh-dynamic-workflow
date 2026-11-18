// Vendor and contract tiers (vitest): `npm run test:vendor`.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const vendor = (path: string): string => fileURLToPath(new URL(`./vendor/dynamic-workflow/src/${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@zcode\/dynamic-workflow\/testing$/u, replacement: vendor('testing/index.ts') },
      { find: /^@zcode\/dynamic-workflow$/u, replacement: vendor('index.ts') },
    ],
  },
  test: {
    include: ['tests/vendor/**/*.test.ts'],
  },
})
