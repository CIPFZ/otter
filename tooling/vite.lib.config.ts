// Shared Vite library build for every @otter-player/* JS package.
// Invoked from a package directory: `vite build --config ../../tooling/vite.lib.config.ts`.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const pkgDir = process.cwd();
const shims = resolve(import.meta.dirname, 'shims');

// Every bare import (workspace packages, third-party deps, node builtins) stays external:
// each package ships only its own code and consumers dedupe shared modules.
// Exception, `otter.bundle` in package.json: CommonJS dependencies whose Node-only requires
// break browser bundlers (imscJS -> sax -> stream / string_decoder). They are bundled into the
// package's lazy chunk, with the Node builtins replaced by stubs (tooling/shims).
const manifest = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8')) as {
  otter?: { bundle?: string[]; entries?: Record<string, string>; assets?: string[] };
};
// Extra entry points (package.json otter.entries: { name: src path }), built next to index, for
// sub-path exports that must not ride along with the main entry (ADR-007 §2).
const entries: Record<string, string> = {
  index: resolve(pkgDir, 'src/index.ts'),
  ...Object.fromEntries(Object.entries(manifest.otter?.entries ?? {}).map(([name, src]) => [name, resolve(pkgDir, src)])),
};
const bundled = manifest.otter?.bundle ?? [];
const isBundled = (id: string): boolean => bundled.some((b) => id === b || id.startsWith(`${b}/`)) || id === 'stream' || id === 'string_decoder';
const isExternal = (id: string): boolean =>
  !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !(bundled.length > 0 && isBundled(id));

/**
 * dist keeps tsc's .d.ts (emptyOutDir: false), so old hashed chunks would pile up and be counted by
 * the size report. Drop previous JS output (and the hashed Worker scripts in assets/) before each build.
 */
const cleanJs = {
  name: 'otter-clean-js',
  buildStart(): void {
    const dist = resolve(pkgDir, 'dist');
    if (!existsSync(dist)) return;
    for (const f of readdirSync(dist)) if (/\.(js|js\.map)$/.test(f)) rmSync(resolve(dist, f));
    // Worker scripts (`new Worker(new URL(...))`) are emitted, hashed, under assets/.
    const assets = resolve(dist, 'assets');
    if (existsSync(assets)) for (const f of readdirSync(assets)) if (/\.(js|js\.map)$/.test(f)) rmSync(resolve(assets, f));
  },
};

/**
 * `otter.assets` in package.json: directories under src/ copied as they are to the same place
 * under dist/ (WASM modules and their glue, loaded at runtime next to the code that uses them).
 */
const copyAssets = {
  name: 'otter-copy-assets',
  closeBundle(): void {
    for (const dir of manifest.otter?.assets ?? []) {
      if (!dir.startsWith('src/')) throw new Error(`otter.assets entries live under src/: ${dir}`);
      cpSync(resolve(pkgDir, dir), resolve(pkgDir, 'dist', dir.slice(4)), { recursive: true });
    }
  },
};

export default defineConfig({
  root: pkgDir,
  // Worker / asset URLs relative to the module (new URL('./x', import.meta.url)), not to a site root.
  base: './',
  plugins: [cleanJs, copyAssets],
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
      entry: entries,
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: isExternal,
    },
  },
});
