// The React example app (ADR-013 batch 3): <OtterPlayer> with the page's preset and the time from
// useOtterState. Rendered in Node at build time (react-ssr.tsx, e2e/framework-ssr.ts) and hydrated
// by react.tsx; the player is made after hydration.

import { OtterPlayer, useOtterState } from '@otter-player/react';
import { useState, type ReactElement } from 'react';
import { create, storeOf, type ExamplePlayer, type ExamplePreset } from './example-presets.ts';

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
