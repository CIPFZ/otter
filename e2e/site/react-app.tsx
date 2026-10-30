// The React example (ADR-013 batch 3): one page per preset (basic, vod, surveillance), each a React
// app around <OtterPlayer>. The page is rendered on the server (at build time here, by
// e2e/react-ssr.ts, in Node) and hydrated in the browser; the player is made after hydration.
// The source comes from the page's query (?src= / ?streams=), read only when the player is made.

import { OtterPlayer, useOtterState } from '@otter-player/react';
import { createBasicPlayer, type BasicPlayer } from '@otter-player/presets/basic';
import { createSurveillancePlayer, type SurveillancePlayer } from '@otter-player/presets/surveillance';
import { createVodPlayer } from '@otter-player/presets/vod';
import type { Player } from '@otter-player/presets';
import { useState, type ReactElement } from 'react';

export type ExamplePreset = 'basic' | 'vod' | 'surveillance';
export type ExamplePlayer = BasicPlayer | Player | SurveillancePlayer;

const query = (name: string, fallback: string): string => new URLSearchParams(location.search).get(name) ?? fallback;

const create: Record<ExamplePreset, (container: HTMLElement) => ExamplePlayer> = {
  basic(container) {
    const p = createBasicPlayer({ container, muted: true, idleMs: 0 });
    void p.load(query('src', '/hls-fmp4/master.m3u8'), { autoplay: true });
    return p;
  },
  vod(container) {
    const p = createVodPlayer({ container, title: 'React + vod', muted: true, idleMs: 0 });
    void p.load(query('src', '/hls-fmp4/master.m3u8'), { autoplay: true });
    return p;
  },
  surveillance(container) {
    return createSurveillancePlayer({ container, title: 'React + surveillance', idleMs: 0, streams: query('streams', '/live/stream.flv,/live/stream.flv').split(',') });
  },
};

/** The store whose time the page shows: the player's, or the first tile's on a wall. */
const storeOf = (p: ExamplePlayer | null) => (p === null ? null : 'tiles' in p ? (p.tiles[0]?.store ?? null) : p.store);

export function App({ preset, onPlayer }: { preset: ExamplePreset; onPlayer?: (p: ExamplePlayer | null) => void }): ReactElement {
  const [player, setPlayer] = useState<ExamplePlayer | null>(null);
  const seconds = useOtterState(storeOf(player), (s) => Math.floor(s.currentTime));
  const status = useOtterState(storeOf(player), (s) => s.status);
  return (
    <main>
      <h1>Otter + React: {preset}</h1>
      <OtterPlayer
        create={create[preset]}
        onPlayer={(p) => {
          setPlayer(p);
          onPlayer?.(p);
        }}
        className="player"
      />
      <p>
        <span data-testid="status">{status ?? 'server'}</span> · <span data-testid="time">{seconds ?? 0}</span> s
      </p>
    </main>
  );
}
