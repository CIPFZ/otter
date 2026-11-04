# @otter-player/svelte

Svelte bindings (SPEC §16, ADR-013 batch 3): an action and a component that host a player made by a preset, and a store that reads its state. Same scope as `@otter-player/react`: only through the store's `getState` / `subscribe`, no Otter runtime inside, the host passes the preset. Svelte 5 (peer).

```svelte
<script>
  import OtterPlayer from '@otter-player/svelte/OtterPlayer.svelte';
  import { otterState } from '@otter-player/svelte';
  import { createVodPlayer } from '@otter-player/presets/vod';
  import '@otter-player/ui-skin-default';

  let { src } = $props();
  let player = $state.raw(null);
  const paused = $derived(otterState(player?.store, (s) => s.paused));
  const create = (container) => {
    const p = createVodPlayer({ container, title: 'Example' });
    void p.load(src);
    return p;
  };
</script>

<OtterPlayer {create} deps={[src]} poster="/poster.jpg" onplayer={(p) => (player = p)} />
<button onclick={() => player?.store.dispatch($paused ? 'play' : 'pause', undefined)}>{$paused ? 'Play' : 'Pause'}</button>
```

- `OtterPlayer.svelte` (props: `create deps onplayer aspectRatio poster class`): shipped as source (the `svelte` export condition) and compiled by the host's Svelte toolchain; inside it is the action below.
- `use:otterPlayer={{ create, deps, onPlayer }}`: makes a fresh child container in the element and the player in it; destroyed when the element goes or `deps` changes. For hosts that render their own box.
- `otterState(store, selector, equals?)`: a Svelte store (`$paused`) that notifies only when the selected slice changes. Undefined while `store` is empty.
- The main entry is plain TypeScript and does not import Svelte.

## Server rendering

- The action runs only in the browser, after hydration; its element is the empty box rendered on the server (with `aspect-ratio` and an optional poster).
- During server rendering Svelte subscribes to a store, reads the value and unsubscribes, leaving no listener.
- Examples: `e2e/site/svelte-{basic,vod,surveillance}.html`, rendered in Node at build time and hydrated in the browser with `hydrate`; Svelte's production build does not report hydration mismatches, so `e2e/bindings.spec.ts` checks instead that the server-rendered box element is still the same element after hydration.
