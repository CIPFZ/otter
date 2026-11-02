// The Vue example app (ADR-013 batch 3): <OtterPlayer> with the page's preset and the time from
// useOtterState. Rendered in Node at build time (vue-ssr.ts, e2e/framework-ssr.ts) and hydrated by
// vue.ts (createSSRApp + mount); the player is made after mount.
import { OtterPlayer, useOtterState } from '@otter-player/vue';
import { createSSRApp, defineComponent, h, shallowRef, type App } from 'vue';
import { create, storeOf, type ExamplePlayer, type ExamplePreset } from './example-presets.ts';

export function createExampleApp(preset: ExamplePreset, onPlayer?: (p: ExamplePlayer | null) => void): App {
  return createSSRApp(
    defineComponent(() => {
      const player = shallowRef<ExamplePlayer | null>(null);
      const store = () => storeOf(player.value);
      const seconds = useOtterState(store, (s) => Math.floor(s.currentTime));
      const status = useOtterState(store, (s) => s.status);
      return () =>
        h('main', [
          h('h1', `Otter + Vue: ${preset}`),
          h(OtterPlayer, {
            create: create[preset],
            class: 'player',
            onPlayer: (made: unknown) => {
              const p = made as ExamplePlayer | null;
              player.value = p;
              onPlayer?.(p);
            },
          }),
          h('p', [h('span', { 'data-testid': 'status' }, status.value ?? 'server'), ' · ', h('span', { 'data-testid': 'time' }, String(seconds.value ?? 0)), ' s']),
        ]);
    }),
  );
}
