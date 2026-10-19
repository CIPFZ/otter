// Shared Vite library build for every @otter-player/* JS package.
// Invoked from a package directory: `vite build --config ../../tooling/vite.lib.config.ts`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const pkgDir = process.cwd();
const shims = resolve(import.meta.dirname, 'shims');

// Every bare import (workspace packages, third-party deps, node builtins) stays external:
// each package ships only its own code and consumers dedupe shared modules.
// Exception, `otter.bundle` in package.json: CommonJS dependencies whose Node-only requires
// break browser bundlers (imscJS -> sax -> stream / string_decoder). They are bundled into the
// package's lazy chunk, with the Node builtins replaced by stubs (tooling/shims).
const manifest = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8')) as { otter?: { bundle?: string[] } };
const bundled = manifest.otter?.bundle ?? [];
const isBundled = (id: string): boolean => bundled.some((b) => id === b || id.startsWith(`${b}/`)) || id === 'stream' || id === 'string_decoder';
const isExternal = (id: string): boolean =>
  !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !(bundled.length > 0 && isBundled(id));

export default defineConfig({
  root: pkgDir,
  ...(bundled.length > 0
    ? { resolve: { alias: { stream: resolve(shims, 'stream.js'), string_decoder: resolve(shims, 'string_decoder.js') } } }
    : {}),
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
