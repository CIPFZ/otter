// Dev server for the Playwright fixture site. Packages resolve to their sources (same alias as
// Vitest); local test media (e2e/media) is served from the root; /live/stream.flv is a paced
// local HTTP-FLV live stream.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { liveFlvPlugin } from './live-flv.ts';

const packagesDir = fileURLToPath(new URL('../packages/', import.meta.url));
const mediaDir = fileURLToPath(new URL('./media/', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./site/', import.meta.url)),
  publicDir: mediaDir,
  logLevel: 'warn',
  plugins: [liveFlvPlugin(`${mediaDir}flv/clip.flv`)],
  resolve: {
    alias: [
      { find: /^\/@otter-skin\/(.*)$/, replacement: `${packagesDir}ui-skin-default/src/$1` },
      { find: /^@otter-player\/pipeline\/transmux$/, replacement: `${packagesDir}pipeline/src/transmux/index.ts` },
      { find: /^@otter-player\/pipeline\/captions$/, replacement: `${packagesDir}pipeline/src/captions/cea608.ts` },
      { find: /^@otter-player\/text\/render$/, replacement: `${packagesDir}text/src/render.ts` },
      { find: /^@otter-player\/([a-z0-9-]+)$/, replacement: `${packagesDir}$1/src/index.ts` },
      { find: /^@otter-vendor\/([a-z0-9.-]+)$/, replacement: fileURLToPath(new URL('../vendor/$1/src/index.ts', import.meta.url)) },
      // imscJS -> sax requires Node builtins; the package build bundles stubs (tooling/shims).
      { find: /^stream$/, replacement: fileURLToPath(new URL('../tooling/shims/stream.js', import.meta.url)) },
      { find: /^string_decoder$/, replacement: fileURLToPath(new URL('../tooling/shims/string_decoder.js', import.meta.url)) },
    ],
  },
  build: {
    outDir: fileURLToPath(new URL('./.site-dist/', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./site/index.html', import.meta.url)),
        player: fileURLToPath(new URL('./site/player.html', import.meta.url)),
        transmux: fileURLToPath(new URL('./site/transmux.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 4173,
    strictPort: true,
    // Real devices reach the fixture over the LAN or a tunnel: OTTER_E2E_EXPOSE=1.
    host: process.env['OTTER_E2E_EXPOSE'] === '1' ? '0.0.0.0' : 'localhost',
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: process.env['OTTER_E2E_EXPOSE'] === '1' ? '0.0.0.0' : 'localhost',
  },
});
