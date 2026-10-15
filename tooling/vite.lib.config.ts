// Shared Vite library build for every @otter-player/* JS package.
// Invoked from a package directory: `vite build --config ../../tooling/vite.lib.config.ts`.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const pkgDir = process.cwd();

// Every bare import (workspace packages, third-party deps, node builtins) stays external:
// each package ships only its own code and consumers dedupe shared modules.
const isExternal = (id: string): boolean => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0');

export default defineConfig({
  root: pkgDir,
  logLevel: 'warn',
  build: {
    target: 'es2022',
    outDir: 'dist',
    // d.ts files are emitted into dist by `tsc -b`; do not wipe them.
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    lib: {
      entry: resolve(pkgDir, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: isExternal,
    },
  },
});
