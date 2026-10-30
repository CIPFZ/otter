// @vitest-environment node
// Server rendering in plain Node (no DOM): the three presets of the first React stop (basic, vod,
// surveillance), imported as a server bundle would and rendered through <OtterPlayer>. Nothing may
// touch window, document or AudioContext on the server (owner 2026-10-30): the globals are traps
// that record every read, set before the imports.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const touched: string[] = [];
const TRAPS = ['window', 'document', 'AudioContext', 'webkitAudioContext', 'HTMLElement', 'customElements', 'requestAnimationFrame', 'location'] as const;

beforeAll(() => {
  for (const name of TRAPS) {
    expect(name in globalThis, `${name} exists in this Node`).toBe(false);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
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
      basic: createElement(OtterPlayer, {
        create: (container: HTMLElement) => {
          made.push('basic');
          return createBasicPlayer({ container });
        },
        poster: '/poster.jpg',
      }),
      vod: createElement(OtterPlayer, {
        create: (container: HTMLElement) => {
          made.push('vod');
          return createVodPlayer({ container, title: 'VOD' });
        },
      }),
      surveillance: createElement(OtterPlayer, {
        create: (container: HTMLElement) => {
          made.push('surveillance');
          return createSurveillancePlayer({ container, streams: ['/cam/1.flv', '/cam/2.flv'] });
        },
        aspectRatio: '16 / 9',
      }),
    };
    for (const [name, page] of Object.entries(pages)) {
      const html = renderToString(page);
      expect(html, name).toMatch(/^<div data-otter-react="" style="[^"]*aspect-ratio:16 \/ 9/);
    }
    // A state hook with no player yet (the server): undefined, no store needed.
    expect(renderToString(createElement(() => createElement('span', null, String(useOtterState(null, (s: { paused: boolean }) => s.paused)))))).toBe('<span>undefined</span>');
    expect(made).toEqual([]);
    expect(touched).toEqual([]);
  });
});
