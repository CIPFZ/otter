// The framework example pages (React, Vue, Svelte; ADR-013 batch 3): one page per preset (basic,
// vod, surveillance). The players are made the same way in all three: these factories, called by
// each binding after hydration (they read the page's query: ?src= / ?streams=).

import { createBasicPlayer, type BasicPlayer } from '@otter-player/presets/basic';
import { createSurveillancePlayer, type SurveillancePlayer } from '@otter-player/presets/surveillance';
import { createVodPlayer } from '@otter-player/presets/vod';
import type { Player } from '@otter-player/presets';

export type ExamplePreset = 'basic' | 'vod' | 'surveillance';
export type ExamplePlayer = BasicPlayer | Player | SurveillancePlayer;
export type ExampleFramework = 'react' | 'vue' | 'svelte';

const query = (name: string, fallback: string): string => new URLSearchParams(location.search).get(name) ?? fallback;

export const create: Record<ExamplePreset, (container: HTMLElement) => ExamplePlayer> = {
  basic(container) {
    const p = createBasicPlayer({ container, muted: true, idleMs: 0 });
    void p.load(query('src', '/hls-fmp4/master.m3u8'), { autoplay: true });
    return p;
  },
  vod(container) {
    const p = createVodPlayer({ container, title: 'Example: vod', muted: true, idleMs: 0 });
    void p.load(query('src', '/hls-fmp4/master.m3u8'), { autoplay: true });
    return p;
  },
  surveillance(container) {
    return createSurveillancePlayer({ container, title: 'Example: surveillance', idleMs: 0, streams: query('streams', '/live/stream.flv,/live/stream.flv').split(',') });
  },
};

/** The store whose time the page shows: the player's, or the first tile's on a wall. */
export const storeOf = (p: ExamplePlayer | null) => (p === null ? null : 'tiles' in p ? (p.tiles[0]?.store ?? null) : p.store);

declare global {
  interface Window {
    /** The page's player (null before hydration), for the tests. */
    examplePlayer?: ExamplePlayer | null;
    /** Hydration problems the framework reported. */
    hydrationErrors?: string[];
  }
}
