<!--
  A player made by a preset, as a component (Svelte 5). Server-rendered as the empty box (aspect
  ratio, poster), the same markup the client hydrates; the player is made by the otterPlayer action
  after hydration, inside a fresh child of the box.
-->
<script>
  import { otterPlayer } from '@otter-player/svelte';

  /** @type {{ create: (container: HTMLElement) => { destroy(): unknown }, deps?: readonly unknown[], onplayer?: (player: { destroy(): unknown } | null) => void, aspectRatio?: string, poster?: string, class?: string }} */
  let { create, deps = [], onplayer, aspectRatio = '16 / 9', poster, class: className } = $props();
</script>

<div
  data-otter-svelte
  class={className}
  style:position="relative"
  style:aspect-ratio={aspectRatio}
  style:background-image={poster === undefined ? undefined : `url(${JSON.stringify(poster)})`}
  style:background-size={poster === undefined ? undefined : 'cover'}
  style:background-position={poster === undefined ? undefined : 'center'}
  use:otterPlayer={{ create, deps, onPlayer: onplayer }}
></div>
