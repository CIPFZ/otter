import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources; no build needed.
    alias: [
      { find: /^@otter-player\/pipeline\/transmux$/, replacement: `${packagesDir}pipeline/src/transmux/index.ts` },
      { find: /^@otter-player\/([a-z0-9-]+)$/, replacement: `${packagesDir}$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'vendor/*/test/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    environment: 'node',
  },
});
