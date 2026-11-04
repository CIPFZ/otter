// The docs' examples, runnable (?example=<name>&src=<url>[,<url>...]): each module in examples/
// holds one between `// #region example:<name>` markers, the same code as its @example in the
// TSDoc (pnpm check:docs-site). The bindings' examples are components, mounted here in the browser.
// window.docExample: the player of a plain example, for the tests (e2e/examples.spec.ts).

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { mount } from 'svelte';
import { createApp } from 'vue';
import { container, src } from './examples/page.ts';

declare global {
  interface Window {
    docExample?: unknown;
    docExampleError?: string;
  }
}

const modules: Readonly<Record<string, () => Promise<{ player: unknown }>>> = {
  createPlayer: () => import('./examples/create-player.ts'),
  basic: () => import('./examples/basic.ts'),
  vod: () => import('./examples/vod.ts'),
  live: () => import('./examples/live.ts'),
  lowlatency: () => import('./examples/lowlatency.ts'),
  'ott-drm': () => import('./examples/ott-drm.ts'),
  surveillance: () => import('./examples/surveillance.ts'),
  danmaku: () => import('./examples/danmaku.ts'),
  shorts: () => import('./examples/shorts.ts'),
  tv: () => import('./examples/tv.ts'),
  background: () => import('./examples/background.ts'),
};
const name = new URLSearchParams(location.search).get('example') ?? '';

const run = async (): Promise<void> => {
  if (name === 'react') {
    const { Video } = await import('./examples/react.tsx');
    createRoot(container).render(createElement(Video, { src }));
  } else if (name === 'vue') {
    const { Video } = await import('./examples/vue.ts');
    createApp(Video, { src }).mount(container);
  } else if (name === 'svelte') {
    const { default: Video } = await import('./examples/Svelte.svelte');
    mount(Video, { target: container, props: { src } });
  } else {
    const load = modules[name];
    if (load === undefined) throw new Error(`no example ${name}`);
    window.docExample = (await load()).player;
  }
};
run().catch((e: unknown) => {
  window.docExampleError = String(e);
});
