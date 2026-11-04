# @otter-player/react

React bindings (SPEC §16, ADR-013 batch 3): a component that hosts a player made by a preset, and a hook that reads its store. Only through the store's `getState` / `subscribe` (the host gives commands through `dispatch`), with no Otter runtime inside; the host passes the preset. React ≥ 18 (peer).

```tsx
import { useState } from 'react';
import { OtterPlayer, useOtterState } from '@otter-player/react';
import { createVodPlayer } from '@otter-player/presets/vod';
import type { Player } from '@otter-player/presets';
import '@otter-player/ui-skin-default';

export function Video({ src }: { src: string }) {
  const [player, setPlayer] = useState<Player | null>(null);
  const paused = useOtterState(player?.store, (s) => s.paused);
  return (
    <>
      <OtterPlayer
        create={(container) => {
          const p = createVodPlayer({ container, title: 'Example' });
          void p.load(src);
          return p;
        }}
        deps={[src]}
        onPlayer={setPlayer}
        poster="/poster.jpg"
      />
      <button onClick={() => player?.store.dispatch(paused ? 'play' : 'pause', undefined)}>{paused ? 'Play' : 'Pause'}</button>
    </>
  );
}
```

- `<OtterPlayer create deps onPlayer aspectRatio poster className style id>`: the player is made in an effect after mount, in a fresh child container of the component's box; it is destroyed on unmount or when `deps` changes, and the child container goes with it. Strict Mode's mount, unmount, mount again gets two independent players, one of which remains.
- `useOtterState(store, selector, equals?)`: re-renders only when the selected slice changes (`equals` defaults to `Object.is`). With a null / undefined `store` (no player yet, on the server) it returns undefined.
- `useOtterPlayer(create, deps)`: the hook behind the component, for hosts that render their own box.

## Server rendering

- Rendering touches no `window`, `document` or `AudioContext`. The server and the client's first render output the same: an empty box with `aspect-ratio` (default 16 / 9, the space is reserved, no layout shift) and an optional poster background. The player is made only after hydration.
- Every preset's sub-path can be imported on the server: `pnpm check:side-effects` imports every entry in Node one by one, with the browser globals trapped. `defineOtterElements()` does nothing on a server.
- Examples: `e2e/site/react-{basic,vod,surveillance}.html`. Rendered in Node at build time (`e2e/react-ssr.ts`), `hydrateRoot` in the browser; `e2e/react.spec.ts` checks there is no hydration mismatch, that it plays and that the hook follows.
