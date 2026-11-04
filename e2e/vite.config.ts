// Dev server for the Playwright fixture site. Packages resolve to their sources (same alias as
// Vitest); local test media (e2e/media) is served from the root; /live/stream.flv is a paced
// local HTTP-FLV live stream; /whep/* is a local WHEP endpoint (e2e/whep.ts); /live-hls/* a looped live CMAF-HLS stream (e2e/live-hls.ts); /t/<kbps>/<sid>/* the media at a
// limited bandwidth (e2e/throttle.ts, benchmarks).
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { liveFlvPlugin } from './live-flv.ts';
import { liveTsPlugin } from './live-ts.ts';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { frameworkSsrPlugin } from './framework-ssr.ts';
import { liveHlsPlugin } from './live-hls.ts';
import { throttlePlugin } from './throttle.ts';
import { whepPlugin } from './whep.ts';

const packagesDir = fileURLToPath(new URL('../packages/', import.meta.url));
const mediaDir = fileURLToPath(new URL('./media/', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./site/', import.meta.url)),
  publicDir: mediaDir,
  logLevel: 'warn',
  plugins: [
    liveFlvPlugin(`${mediaDir}flv/clip.flv`),
    liveTsPlugin(`${mediaDir}ts/live-loop.ts`),
    whepPlugin(`${mediaDir}whep/clip.ivf`),
    liveHlsPlugin(`${mediaDir}frames/hls-ladder`),
    throttlePlugin(mediaDir),
    // The Svelte bindings' component and the Svelte example app.
    svelte(),
    // The inner SSR server (framework-ssr.ts) loads this config too: without the plugin itself.
    ...(process.env['OTTER_SSR_INNER'] === '1' ? [] : [frameworkSsrPlugin()]),
    // decoder-wasm-hevc loads its WASM next to its own module (otter.assets): in the built site
    // that module lives in assets/.
    // The generated docs site under /docs/ (scripts/docs-site.ts): its preset and binding pages link
    // to this site's example pages and fixtures (pnpm docs:serve).
    {
      name: 'otter-docs-site',
      async writeBundle(options) {
        const { buildDocsSite } = await import('../scripts/docs-site.ts');
        buildDocsSite(`${options.dir as string}/docs`);
      },
    },
    {
      name: 'otter-wasm-assets',
      writeBundle(options) {
        cpSync(`${packagesDir}decoder-wasm-hevc/src/vendor/jessibuca`, `${options.dir as string}/assets/vendor/jessibuca`, { recursive: true });
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^\/@otter-skin\/(.*)$/, replacement: `${packagesDir}ui-skin-default/src/$1` },
      { find: /^\/@otter-skin-tv\/(.*)$/, replacement: `${packagesDir}ui-skin-tv/src/$1` },
      { find: /^@otter-player\/pipeline\/transmux$/, replacement: `${packagesDir}pipeline/src/transmux/index.ts` },
      { find: /^@otter-player\/pipeline\/captions$/, replacement: `${packagesDir}pipeline/src/captions/cea608.ts` },
      { find: /^@otter-player\/text\/render$/, replacement: `${packagesDir}text/src/render.ts` },
      { find: /^@otter-player\/surface\/gpu$/, replacement: `${packagesDir}surface/src/gpu.ts` },
      { find: /^@otter-player\/presentation\/multiview$/, replacement: `${packagesDir}presentation/src/multiview.ts` },
      { find: /^@otter-player\/presentation\/canvas-pip$/, replacement: `${packagesDir}presentation/src/canvas-pip.ts` },
      { find: /^@otter-player\/engine-pipeline\/fallback$/, replacement: `${packagesDir}engine-pipeline/src/fallback.ts` },
      { find: /^@otter-player\/engine-pipeline\/sink$/, replacement: `${packagesDir}engine-pipeline/src/mse-sink.ts` },
      { find: /^@otter-player\/engine-pipeline\/demux$/, replacement: `${packagesDir}engine-pipeline/src/flv-demux.ts` },
      { find: /^@otter-player\/presentation\/picture$/, replacement: `${packagesDir}presentation/src/picture.ts` },
      { find: /^@otter-player\/presentation\/single-audio$/, replacement: `${packagesDir}presentation/src/single-audio.ts` },
      { find: /^@otter-player\/input\/remote$/, replacement: `${packagesDir}input/src/remote.ts` },
      { find: /^@otter-player\/svelte\/OtterPlayer\.svelte$/, replacement: `${packagesDir}svelte/src/OtterPlayer.svelte` },
      // The skins are CSS-only packages: their source stylesheet.
      { find: /^@otter-player\/(ui-skin-[a-z]+)$/, replacement: `${packagesDir}$1/src/index.css` },
      { find: /^@otter-player\/presets\/([a-z0-9-]+)$/, replacement: `${packagesDir}presets/src/$1.ts` },
      // OTTER_E2E_DIST=format-hls,...: those packages from their built dist/ (what ships: format-hls
      // renames its internal `_` properties at build time, ADR-013); everything else from source.
      ...(process.env['OTTER_E2E_DIST'] ?? '')
        .split(',')
        .filter((name) => /^[a-z0-9-]+$/.test(name))
        .map((name) => ({ find: new RegExp(`^@otter-player/${name}$`), replacement: `${packagesDir}${name}/dist/index.js` })),
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
        surfaces: fileURLToPath(new URL('./site/surfaces.html', import.meta.url)),
        webcodecs: fileURLToPath(new URL('./site/webcodecs.html', import.meta.url)),
        presets: fileURLToPath(new URL('./site/presets.html', import.meta.url)),
        examples: fileURLToPath(new URL('./site/examples.html', import.meta.url)),
        tv: fileURLToPath(new URL('./site/tv.html', import.meta.url)),
        'react-basic': fileURLToPath(new URL('./site/react-basic.html', import.meta.url)),
        'react-vod': fileURLToPath(new URL('./site/react-vod.html', import.meta.url)),
        'react-surveillance': fileURLToPath(new URL('./site/react-surveillance.html', import.meta.url)),
        'vue-basic': fileURLToPath(new URL('./site/vue-basic.html', import.meta.url)),
        'vue-vod': fileURLToPath(new URL('./site/vue-vod.html', import.meta.url)),
        'vue-surveillance': fileURLToPath(new URL('./site/vue-surveillance.html', import.meta.url)),
        'svelte-basic': fileURLToPath(new URL('./site/svelte-basic.html', import.meta.url)),
        'svelte-vod': fileURLToPath(new URL('./site/svelte-vod.html', import.meta.url)),
        'svelte-surveillance': fileURLToPath(new URL('./site/svelte-surveillance.html', import.meta.url)),
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
