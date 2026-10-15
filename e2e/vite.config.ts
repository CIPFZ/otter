// Dev server for the Playwright fixture site. Packages resolve to their sources (same alias as Vitest).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const packagesDir = fileURLToPath(new URL('../packages/', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./site/', import.meta.url)),
  logLevel: 'warn',
  resolve: {
    alias: [{ find: /^@otter-player\/([a-z0-9-]+)$/, replacement: `${packagesDir}$1/src/index.ts` }],
  },
  server: {
    port: 4173,
    strictPort: true,
    // Real devices reach the fixture over the LAN or a tunnel: OTTER_E2E_EXPOSE=1.
    host: process.env['OTTER_E2E_EXPOSE'] === '1' ? '0.0.0.0' : 'localhost',
  },
});
