// @vitest-environment node
// Server rendering in plain Node (no DOM), Svelte: the three presets (basic, vod, surveillance),
// imported as a server bundle would and rendered through <OtterPlayer> (compiled for the server).
// Nothing may touch window, document or AudioContext on the server (owner 2026-10-30): the globals
// are traps that record every read from Otter's code, set before the imports.
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
        // The framework's own `typeof document` checks do not count: only reads from Otter's code.
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

describe('server rendering (Svelte)', () => {
  it('imports the presets and renders <OtterPlayer> for basic, vod and surveillance without touching window, document or AudioContext', async () => {
    const { render } = await import('svelte/server');
    const { default: OtterPlayer } = await import('../src/OtterPlayer.svelte');
    const { otterState } = await import('../src/index.js');
    const { createBasicPlayer } = await import('@otter-player/presets/basic');
    const { createVodPlayer } = await import('@otter-player/presets/vod');
    const { createSurveillancePlayer } = await import('@otter-player/presets/surveillance');
    const made: string[] = [];
    const pages = {
      basic: { create: (container: HTMLElement) => (made.push('basic'), createBasicPlayer({ container })), poster: '/poster.jpg' },
      vod: { create: (container: HTMLElement) => (made.push('vod'), createVodPlayer({ container, title: 'VOD' })) },
      surveillance: { create: (container: HTMLElement) => (made.push('surveillance'), createSurveillancePlayer({ container, streams: ['/cam/1.flv', '/cam/2.flv'] })) },
    };
    for (const [name, props] of Object.entries(pages)) {
      const { body } = render(OtterPlayer, { props });
      expect(body, name).toMatch(/<div data-otter-svelte=""[^>]*style="[^"]*aspect-ratio: 16 \/ 9/);
    }
    // The store adapter as a server render uses it (subscribe, read, unsubscribe): no listener left.
    let listeners = 0;
    const store = { getState: () => ({ n: 7 }), subscribe: () => (listeners++, () => void listeners--) };
    const seen: unknown[] = [];
    otterState(store, (s) => s.n).subscribe((v) => seen.push(v))();
    expect(seen).toEqual([7]);
    expect(listeners).toBe(0);
    expect(made).toEqual([]);
    expect(touched, stacks.join(' || ')).toEqual([]);
  });
});
