# @otter-player/vue

Vue bindings (SPEC §16, ADR-013 batch 3): a component that hosts a player made by a preset, and composables that read its store. Same scope as `@otter-player/react`: only through the store's `getState` / `subscribe` (the host gives commands through `dispatch`), no Otter runtime inside, the host passes the preset. Vue ≥ 3.3 (peer).

```vue
<script setup lang="ts">
import { shallowRef } from 'vue';
import { OtterPlayer, useOtterState } from '@otter-player/vue';
import { createVodPlayer } from '@otter-player/presets/vod';
import type { Player } from '@otter-player/presets';
import '@otter-player/ui-skin-default';

const props = defineProps<{ src: string }>();
const player = shallowRef<Player | null>(null);
const paused = useOtterState(() => player.value?.store, (s) => s.paused);
const create = (container: HTMLElement) => {
  const p = createVodPlayer({ container, title: 'Example' });
  void p.load(props.src);
  return p;
};
</script>

<template>
  <OtterPlayer :create="create" :deps="[props.src]" poster="/poster.jpg" @player="(p) => (player = p as Player | null)" />
  <button @click="player?.store.dispatch(paused ? 'play' : 'pause', undefined)">{{ paused ? 'Play' : 'Pause' }}</button>
</template>
```

- `<OtterPlayer create deps aspectRatio poster @player>`: the player is made in `onMounted`, in a fresh child container of the component's box; it is destroyed on unmount or when `deps` changes, and the child container goes with it.
- `useOtterState(store, selector, equals?)`: `store` may be a store, a ref or a getter; returns a shallowRef updated only when the selected slice changes. Undefined while there is no player.
- `useOtterPlayer(create, deps)`: the composable behind the component.

## Server rendering

- setup and render touch no `window`, `document` or `AudioContext`. The server and the client's first render are the same: an empty box with `aspect-ratio` (default 16 / 9) and an optional poster; the player is made only after `onMounted`.
- On the server `useOtterState` reads the store's initial state (`getInitialState`); it subscribes only once mounted.
- Examples: `e2e/site/vue-{basic,vod,surveillance}.html`, rendered in Node at build time and hydrated in the browser with `createSSRApp(...).mount()`; `e2e/bindings.spec.ts`.
