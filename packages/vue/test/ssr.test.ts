// @vitest-environment node
// Server rendering in plain Node (no DOM), Vue: the three presets (basic, vod, surveillance),
// imported as a server bundle would and rendered through <OtterPlayer>. Nothing may
// touch window, document or AudioContext on the server (owner 2026-10-30): the globals are traps
// that record every read, set before the imports.
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const touched: string[] = [];
const stacks: string[] = [];
const TRAPS = ['window', 'document', 'AudioContext', 'webkitAudioContext', 'HTMLElement', 'customElements', 'requestAnimationFrame', 'location'] as const;

beforeAll(() => {
  for (const name of TRAPS) {
    expect(name in globalThis, `${name} exists in this Node`).toBe(false);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        // Vue's own renderer checks `typeof window` (devtools hook): only reads from Otter's code count.
        const stack = String(new Error().stack).split('\n').slice(2);
        if (stack[0]?.includes('/node_modules/') === true) return undefined;
        touched.push(name);
        stacks.push(stack.slice(0, 3).join(' <- '));
        return undefined;
      },
    });
  }
});
afterAll(() => {
  for (const name of TRAPS) delete (globalThis as Record<string, unknown>)[name];
});

describe('server rendering', () => {
  it('imports the presets and renders <OtterPlayer> for basic, vod and surveillance without touching window, document or AudioContext', async () => {
    const { OtterPlayer, useOtterState } = await import('../src/index.js');
    const { createBasicPlayer } = await import('@otter-player/presets/basic');
    const { createVodPlayer } = await import('@otter-player/presets/vod');
    const { createSurveillancePlayer } = await import('@otter-player/presets/surveillance');
    const made: string[] = [];
    const pages = {
      basic: () => h(OtterPlayer, { create: (container: HTMLElement) => (made.push('basic'), createBasicPlayer({ container })), poster: '/poster.jpg' }),
      vod: () => h(OtterPlayer, { create: (container: HTMLElement) => (made.push('vod'), createVodPlayer({ container, title: 'VOD' })) }),
      surveillance: () => h(OtterPlayer, { create: (container: HTMLElement) => (made.push('surveillance'), createSurveillancePlayer({ container, streams: ['/cam/1.flv', '/cam/2.flv'] })), aspectRatio: '16 / 9' }),
    };
    for (const [name, render] of Object.entries(pages)) {
      const html = await renderToString(createSSRApp({ render }));
      expect(html, name).toMatch(/^<div data-otter-vue style="[^"]*aspect-ratio:16 \/ 9/);
    }
    // A state composable with no player yet (the server): undefined, no store needed.
    const none = await renderToString(createSSRApp({ setup: () => { const v = useOtterState(null, (s: { paused: boolean }) => s.paused); return () => h('span', String(v.value)); } }));
    expect(none).toBe('<span>undefined</span>');
    expect(made).toEqual([]);
    expect(touched, stacks.join(" || ")).toEqual([]);
  });
});
