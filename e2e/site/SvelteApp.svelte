<!--
  The Svelte example app (ADR-013 batch 3): <OtterPlayer> with the page's preset and the time from
  the otterState store. Rendered in Node at build time (svelte-ssr.ts, e2e/framework-ssr.ts) and
  hydrated by svelte.ts; the player is made after hydration.
-->
<script>
  import OtterPlayer from '@otter-player/svelte/OtterPlayer.svelte';
  import { otterState } from '@otter-player/svelte';
  import { create, storeOf } from './example-presets.ts';

  let { preset, onplayer = undefined } = $props();
  let player = $state.raw(null);
  const status = $derived(otterState(storeOf(player), (s) => s.status));
  const seconds = $derived(otterState(storeOf(player), (s) => Math.floor(s.currentTime)));
</script>

<main>
  <h1>Otter + Svelte: {preset}</h1>
  <OtterPlayer
    create={create[preset]}
    class="player"
    onplayer={(p) => {
      player = p;
      onplayer?.(p);
    }}
  />
  <p><span data-testid="status">{$status ?? 'server'}</span> · <span data-testid="time">{$seconds ?? 0}</span> s</p>
</main>
