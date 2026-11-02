import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

export default defineConfig({
  // .svelte files (the Svelte bindings' component): compiled for the DOM in happy-dom tests and for
  // the server in node ones.
  plugins: [svelte()],
  resolve: {
    // Tests run against package sources; no build needed.
    alias: [
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
      { find: /^@otter-player\/presets\/([a-z0-9-]+)$/, replacement: `${packagesDir}presets/src/$1.ts` },
      { find: /^@otter-player\/([a-z0-9-]+)$/, replacement: `${packagesDir}$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'vendor/*/test/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    environment: 'node',
  },
});
